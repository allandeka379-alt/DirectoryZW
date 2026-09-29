import type { Logger } from "../logger.js";
import { normalize, toCloudPayload, type OutboundMessage } from "./outbound.js";
import type { Channel } from "./types.js";

export interface Transport {
  /** Send a message and return WhatsApp's message ID. */
  send(channel: Channel, to: string, message: OutboundMessage): Promise<string>;
}

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`WhatsApp API error ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * Worth trying again later: network trouble, rate limits, Meta's own errors, and a rejected token
 * (which someone may fix). Other 4xx errors (a closed 24-hour window, a bad number) won't improve.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof WhatsAppApiError)) return true;
  return err.status === 429 || err.status >= 500 || isAuthError(err);
}

export function isAuthError(err: unknown): boolean {
  return err instanceof WhatsAppApiError && (err.status === 401 || err.status === 403);
}

export interface CloudApiOptions {
  graphVersion: string;
  accessToken: string;
  /** Our one WhatsApp number: both sides of the conversation send from it. */
  phoneNumberId: string;
  log: Logger;
  fetchFn?: typeof fetch;
}

/** Sends through Meta's WhatsApp Cloud API. */
export class CloudApiTransport implements Transport {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: CloudApiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async send(_channel: Channel, to: string, message: OutboundMessage): Promise<string> {
    const url = `https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}/messages`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(toCloudPayload(to, message)),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    if (!res.ok) throw new WhatsAppApiError(res.status, body);
    return body.messages?.[0]?.id ?? "";
  }
}

export interface SimulatedMessage {
  seq: number;
  id: string;
  channel: Channel;
  to: string;
  message: OutboundMessage;
  /** Set when the real send would use this approved template (24-hour window closed). */
  template?: string;
  at: string;
}

/** Keeps messages in memory for the local simulator and tests. Templates render as their fallback. */
export class SimulatorTransport implements Transport {
  private seq = 0;
  /** Keeps message IDs unique across restarts, since the database outlives this process. */
  readonly runId = Math.random().toString(36).slice(2, 8);
  readonly outbox: SimulatedMessage[] = [];

  async send(channel: Channel, to: string, message: OutboundMessage): Promise<string> {
    const shown = message.kind === "template" ? message.fallback : message;
    const item: SimulatedMessage = {
      seq: ++this.seq,
      id: `sim-out-${this.runId}-${this.seq}`,
      channel,
      to,
      message: normalize(shown),
      template: message.kind === "template" ? message.name : undefined,
      at: new Date().toISOString(),
    };
    this.outbox.push(item);
    if (this.outbox.length > 5000) this.outbox.splice(0, 1000);
    return item.id;
  }

  since(channel: Channel, to: string, afterSeq = 0): SimulatedMessage[] {
    return this.outbox.filter((m) => m.channel === channel && m.to === to && m.seq > afterSeq);
  }

  /** Everything sent to one person from our number, from either side of the conversation. */
  sinceAny(to: string, afterSeq = 0): SimulatedMessage[] {
    return this.outbox.filter((m) => m.to === to && m.seq > afterSeq);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
