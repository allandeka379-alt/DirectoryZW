import type { Db } from "../db/client.js";
import { containsPhrase, normalizeText } from "../text.js";

export interface Area {
  id: number;
  name: string;
  city: string;
  lat: number;
  lng: number;
  aliases: string[];
}

/** Suburbs and towns we can place customers and businesses in. */
export class Gazetteer {
  private readonly byId: Map<number, Area>;
  private readonly names: { area: Area; term: string }[];

  constructor(readonly areas: Area[]) {
    this.byId = new Map(areas.map((a) => [a.id, a]));
    this.names = areas.flatMap((a) =>
      [...new Set([a.name, ...a.aliases].map(normalizeText))].filter(Boolean).map((term) => ({ area: a, term })),
    );
  }

  static async load(db: Db): Promise<Gazetteer> {
    const rows = await db.query<Area>("SELECT id, name, city, lat, lng, aliases FROM areas ORDER BY id");
    return new Gazetteer(rows);
  }

  get(id: number | null | undefined): Area | undefined {
    return id == null ? undefined : this.byId.get(id);
  }

  /** The most specific place named in the text: suburbs beat whole cities, longer names beat shorter. */
  match(text: string): Area | undefined {
    const t = normalizeText(text);
    let best: { area: Area; score: number } | undefined;
    for (const { area, term } of this.names) {
      if (!containsPhrase(t, term)) continue;
      const score = term.length + (area.name === area.city ? 0 : 100);
      if (!best || score > best.score) best = { area, score };
    }
    return best?.area;
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
