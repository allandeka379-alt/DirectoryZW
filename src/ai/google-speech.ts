import crypto from "node:crypto";
import fs from "node:fs";
import type { Media } from "../whatsapp/media.js";
import { hintFirst, type SpeechHint, type SpeechToText, type Transcript } from "./speech.js";

/** The fields we use from a Google Cloud service-account key file. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GoogleSpeechOptions {
  projectId: string;
  /** Chirp 2 serves Shona (sn-ZW) from europe-west4 and asia-southeast1. */
  location: string;
  /** BCP-47 codes to try in order, e.g. ["sn-ZW", "zu-ZA", "en-US"]. */
  languages: string[];
  credentials: ServiceAccount;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Google Cloud Speech-to-Text v2 with the Chirp 2 model. Shona is supported; Ndebele isn't, so
 * Zulu (a close relative) stands in for it. Languages are tried in order until one hears
 * something, starting with the language of the person's last request when we know it.
 * Synchronous recognition takes up to a minute of audio, which covers most voice notes.
 */
export class GoogleSpeechToText implements SpeechToText {
  readonly name = "google-chirp-2";
  private readonly fetchFn: typeof fetch;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly opts: GoogleSpeechOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async transcribe(audio: Media, hint?: SpeechHint): Promise<Transcript | null> {
    const languages = hint?.language ? hintFirst(this.opts.languages, (code) => shortLanguage(code) === hint.language) : this.opts.languages;
    for (const code of languages) {
      const text = await this.recognize(audio, code);
      if (text) return { text: text.slice(0, 1000), language: shortLanguage(code) };
    }
    return null;
  }

  private async recognize(audio: Media, languageCode: string): Promise<string> {
    const { projectId, location } = this.opts;
    const url = `https://${location}-speech.googleapis.com/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { autoDecodingConfig: {}, languageCodes: [languageCode], model: "chirp_2" },
        content: audio.data.toString("base64"),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Google speech-to-text failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { results?: { alternatives?: { transcript?: string }[] }[] };
    return (body.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** An OAuth token from the service account (a signed JWT exchanged at Google), reused until near expiry. */
  private async accessToken(): Promise<string> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    const { client_email, private_key, token_uri } = this.opts.credentials;
    const audience = token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(now / 1000);
    const assertion = signJwt(
      { iss: client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: audience, iat, exp: iat + 3600 },
      private_key,
    );
    const res = await this.fetchFn(audience, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google sign-in returned no token");
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

function signJwt(claims: Record<string, unknown>, privateKeyPem: string): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** "sn-ZW" -> "sn"; Zulu stands in for Ndebele, so "zu-ZA" -> "nd". */
export function shortLanguage(code: string): string {
  const base = code.split("-")[0]!.toLowerCase();
  return base === "zu" ? "nd" : base;
}

/** The service-account key, from a file path or the JSON itself. */
export function loadServiceAccount(file?: string, json?: string): ServiceAccount {
  const raw = json ?? (file ? fs.readFileSync(file, "utf8") : undefined);
  if (!raw) throw new Error("No Google service-account credentials given");
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) throw new Error("The Google credentials need client_email and private_key");
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
}
