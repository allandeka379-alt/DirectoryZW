import crypto from "node:crypto";

/** A downloaded photo or voice note. */
export interface Media {
  data: Buffer;
  mimeType: string;
}

/** Fetches the photos and voice notes people send, by WhatsApp media ID. */
export interface MediaSource {
  fetch(mediaId: string): Promise<Media>;
}

export class MediaError extends Error {
  constructor(
    message: string,
    readonly reason: "too_large" | "not_found" | "failed",
  ) {
    super(message);
  }
}

export interface CloudMediaOptions {
  graphVersion: string;
  accessToken: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
}

/**
 * Downloads media from Meta's Cloud API: look up the media ID to get a short-lived URL,
 * then download it with the same access token. Media IDs stay valid for 30 days.
 */
export class CloudMediaSource implements MediaSource {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: CloudMediaOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async fetch(mediaId: string): Promise<Media> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(mediaId)) throw new MediaError("Invalid media ID", "not_found");
    const auth = { Authorization: `Bearer ${this.opts.accessToken}` };
    const meta = await this.fetchFn(`https://graph.facebook.com/${this.opts.graphVersion}/${mediaId}`, { headers: auth });
    if (meta.status === 404) throw new MediaError("Media not found", "not_found");
    if (!meta.ok) throw new MediaError(`Media lookup failed (${meta.status})`, "failed");
    const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) throw new MediaError("Media lookup returned no URL", "failed");
    if (info.file_size && info.file_size > this.opts.maxBytes) throw new MediaError("Media too large", "too_large");
    const file = await this.fetchFn(info.url, { headers: auth });
    if (!file.ok) throw new MediaError(`Media download failed (${file.status})`, "failed");
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length > this.opts.maxBytes) throw new MediaError("Media too large", "too_large");
    return { data, mimeType: baseType(info.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream") };
  }
}

/** Media uploaded in the local simulator. A voice note can carry the words it stands for. */
export class SimulatorMediaSource implements MediaSource {
  private readonly items = new Map<string, Media>();
  private readonly transcripts = new WeakMap<Buffer, string>();

  put(media: Media, transcript?: string): string {
    const id = `sim-media-${crypto.randomUUID()}`;
    this.items.set(id, media);
    if (transcript) this.transcripts.set(media.data, transcript);
    // Keep memory bounded: drop the oldest uploads.
    while (this.items.size > 30) this.items.delete(this.items.keys().next().value!);
    return id;
  }

  async fetch(mediaId: string): Promise<Media> {
    const item = this.items.get(mediaId);
    if (!item) throw new MediaError("Media not found", "not_found");
    return item;
  }

  /** The words a simulated voice note stands for. */
  transcriptFor(data: Buffer): string | undefined {
    return this.transcripts.get(data);
  }
}

/** "audio/ogg; codecs=opus" -> "audio/ogg". */
export function baseType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}
