import type { Media, SimulatorMediaSource } from "../whatsapp/media.js";

export interface Transcript {
  text: string;
  /** Language the service detected, e.g. "sn", "nd" or "en", when it says. */
  language?: string;
}

/** Turns voice notes into text. Returns null when nothing intelligible was said. */
export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Media): Promise<Transcript | null>;
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

  async transcribe(audio: Media): Promise<Transcript | null> {
    const res = await this.fetchFn(this.opts.url, {
      method: "POST",
      headers: {
        "Content-Type": audio.mimeType,
        "X-Language-Hints": this.opts.languages.join(","),
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
