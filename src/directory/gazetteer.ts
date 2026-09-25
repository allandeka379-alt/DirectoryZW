import { allowedEdits, editDistance } from "../ai/fuzzy.js";
import { LOCATIVES } from "../ai/shona.js";
import type { Db } from "../db/client.js";
import { normalizeMessage, normalizeText } from "../text.js";

export interface Area {
  id: number;
  name: string;
  city: string;
  lat: number;
  lng: number;
  aliases: string[];
}

/** Where a place was named in a message's words. */
export interface PlaceMatch {
  area: Area;
  /** First word of the place name, and the word after it. */
  start: number;
  end: number;
}

/** Suburbs and towns we can place customers and businesses in. */
export class Gazetteer {
  private readonly byId: Map<number, Area>;
  private readonly names: { area: Area; term: string; words: string[]; compact: string }[];

  constructor(readonly areas: Area[]) {
    this.byId = new Map(areas.map((a) => [a.id, a]));
    this.names = areas.flatMap((a) =>
      [...new Set([a.name, ...a.aliases].map(normalizeText))]
        .filter(Boolean)
        .map((term) => ({ area: a, term, words: term.split(" "), compact: term.replace(/ /g, "") })),
    );
  }

  static async load(db: Db): Promise<Gazetteer> {
    const rows = await db.query<Area>("SELECT id, name, city, lat, lng, aliases FROM areas ORDER BY id");
    return new Gazetteer(rows);
  }

  get(id: number | null | undefined): Area | undefined {
    return id == null ? undefined : this.byId.get(id);
  }

  /**
   * The most specific place named in the text: suburbs beat whole cities, longer names beat shorter.
   * With `fuzzy`, for replies that should be a place name, a misspelling counts too ("Mabelrein").
   */
  match(text: string, opts: { fuzzy?: boolean } = {}): Area | undefined {
    const words = normalizeMessage(text).split(" ").filter(Boolean);
    const found = this.locate(words)?.area;
    if (found || !opts.fuzzy || !words.length) return found;
    return this.closest(words.join("")) ?? words.map((w) => this.closest(w)).find(Boolean);
  }

  /**
   * The most specific place named in a message's words, and where. The first word may carry a
   * Shona or Ndebele prefix meaning to, at or in: "kuMabelreign", "muHarare", "eNkulumane".
   */
  locate(words: readonly string[]): PlaceMatch | undefined {
    let best: (PlaceMatch & { score: number }) | undefined;
    for (const { area, term, words: name } of this.names) {
      for (let i = 0; i + name.length <= words.length; i++) {
        const fits = name.every((n, k) => {
          const w = words[i + k]!;
          return w === n || (k === 0 && LOCATIVES.some((p) => w === p + n));
        });
        if (!fits) continue;
        const score = term.length + (area.name === area.city ? 0 : 100);
        if (!best || score > best.score) best = { area, start: i, end: i + name.length, score };
      }
    }
    return best && { area: best.area, start: best.start, end: best.end };
  }

  /**
   * Every place named in a message's words, most specific first, not overlapping: "Hillside,
   * Bulawayo" names Hillside and Bulawayo.
   */
  locateAll(words: readonly string[]): PlaceMatch[] {
    const found: PlaceMatch[] = [];
    const taken = new Set<number>();
    for (;;) {
      const free = words.map((w, i) => (taken.has(i) ? "" : w));
      const next = this.locate(free);
      if (!next) return found;
      found.push(next);
      for (let i = next.start; i < next.end; i++) taken.add(i);
    }
  }

  /**
   * The place a word is probably a misspelling of: names of 6 letters or more, same first letter,
   * one letter out (two for 10 or more). Nothing when two places are equally close, so only clear
   * typos count.
   */
  closest(word: string): Area | undefined {
    if (word.length < 6) return undefined;
    const tries = [word, ...LOCATIVES.filter((p) => word.startsWith(p) && word.length - p.length >= 6).map((p) => word.slice(p.length))];
    let best: { area: Area; d: number } | undefined;
    let tie = false;
    for (const { area, compact } of this.names) {
      if (compact.length < 6) continue;
      for (const t of tries) {
        const limit = Math.min(allowedEdits(t.length), allowedEdits(compact.length));
        if (!limit || t[0] !== compact[0]) continue;
        const d = editDistance(t, compact, limit);
        if (d > limit) continue;
        if (!best || d < best.d) {
          best = { area, d };
          tie = false;
        } else if (d === best.d && best.area.id !== area.id) {
          tie = true;
        }
      }
    }
    return best && !tie ? best.area : undefined;
  }

  nearest(lat: number, lng: number): Area | undefined {
    let best: { area: Area; km: number } | undefined;
    for (const area of this.areas) {
      if (area.name === area.city && this.areas.some((a) => a.city === area.city && a.name !== a.city)) continue;
      const km = haversineKm(lat, lng, area.lat, area.lng);
      if (!best || km < best.km) best = { area, km };
    }
    return best?.area;
  }
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
