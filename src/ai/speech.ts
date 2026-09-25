import type { Media, SimulatorMediaSource } from "../whatsapp/media.js";

export interface Transcript {
  text: string;
  /** Language the service detected, e.g. "sn", "nd" or "en", when it says. */
  language?: string;
}

/** What we already know about the speaker: the language of their last request ("sn", "nd" or "en"). */
export interface SpeechHint {
  language?: string;
}

/** Turns voice notes into text. Returns null when nothing intelligible was said. */
export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Media, hint?: SpeechHint): Promise<Transcript | null>;
}

/** Put the hinted language first: ["sn", "nd", "en"] with hint "en" -> ["en", "sn", "nd"]. */
export function hintFirst<T>(items: T[], matches: (item: T) => boolean): T[] {
  return [...items.filter(matches), ...items.filter((i) => !matches(i))];
}

export interface HttpSpeechToTextOptions {
  url: string;
  token?: string;
  /** Languages to expect, most likely first. */
  languages: string[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Calls a speech-to-text service over HTTP, so the engine can be swapped without code changes
 * (Google Chirp 2 for Shona, Meta's Omnilingual ASR, or anything else behind a small adapter).
 *
 * Contract: POST the audio bytes with their Content-Type and an `X-Language-Hints` header
 * ("sn,nd,en"); the service answers `{ "text": "...", "language": "sn" }`.
 */
export class HttpSpeechToText implements SpeechToText {
  readonly name = "http";
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HttpSpeechToTextOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async transcribe(audio: Media, hint?: SpeechHint): Promise<Transcript | null> {
    const languages = hint?.language ? hintFirst(this.opts.languages, (l) => l === hint.language) : this.opts.languages;
    const res = await this.fetchFn(this.opts.url, {
      method: "POST",
      headers: {
        "Content-Type": audio.mimeType,
        "X-Language-Hints": languages.join(","),
        ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: new Uint8Array(audio.data),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Speech-to-text failed (${res.status})`);
    const body = (await res.json()) as { text?: unknown; language?: unknown };
    const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
    if (!text) return null;
    return { text: text.slice(0, 1000), language: typeof body.language === "string" ? body.language : undefined };
  }
}

/** For the local simulator: a "voice note" carries the words typed when it was sent. */
export class SimulatorSpeechToText implements SpeechToText {
  readonly name = "simulator";

  constructor(private readonly media: SimulatorMediaSource) {}

  async transcribe(audio: Media): Promise<Transcript | null> {
    const text = this.media.transcriptFor(audio.data)?.trim();
    return text ? { text } : null;
  }
}
