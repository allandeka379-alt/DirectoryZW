import type { Logger } from "./logger.js";

/** Tells the team when something needs a person: failed jobs, rejected API keys, businesses paused by reports. */
export interface Alerts {
  /** Alerts with the same key are sent at most once per quiet period. */
  send(key: string, text: string): void;
  /** The latest alerts, newest first, for the ops console. */
  readonly recent: readonly { key: string; text: string; at: Date }[];
}

export interface WebhookAlertsOptions {
  /** Slack, Discord or Google Chat incoming webhook. Without one, alerts are only logged. */
  webhookUrl?: string;
  brand: string;
  log: Logger;
  now?: () => Date;
  quietMinutes?: number;
  fetchFn?: typeof fetch;
}

export class WebhookAlerts implements Alerts {
  readonly recent: { key: string; text: string; at: Date }[] = [];
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly opts: WebhookAlertsOptions) {}

  send(key: string, text: string): void {
    const now = this.opts.now?.() ?? new Date();
    const last = this.lastSent.get(key);
    if (last !== undefined && now.getTime() - last < (this.opts.quietMinutes ?? 30) * 60_000) return;
    this.lastSent.set(key, now.getTime());
    this.recent.unshift({ key, text, at: now });
    this.recent.splice(20);
    this.opts.log.error({ alert: key }, text);

    const url = this.opts.webhookUrl;
    if (!url) return;
    const message = `⚠️ ${this.opts.brand}: ${text}`;
    // "text" for Slack and Google Chat, "content" for Discord.
    void (this.opts.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, content: message }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok) this.opts.log.warn({ status: res.status }, "Alert webhook refused the alert");
      })
      .catch((err) => this.opts.log.warn({ err: String(err) }, "Alert webhook unreachable"));
  }
}
