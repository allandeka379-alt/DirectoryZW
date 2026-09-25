import type { Alerts } from "../alerts.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { harareStartOfDay } from "../time.js";
import { costOf, type Usage } from "./pricing.js";

export type AiFeature = "request" | "photo" | "price_list" | "price_list_batch";

/** Records what each Claude call cost. */
export interface UsageMeter {
  record(feature: AiFeature, model: string, usage: Usage, contactId?: string, opts?: { batch?: boolean }): Promise<void>;
}

export interface ClaudeBudgetOptions {
  db: Db;
  /** Stop calling Claude for the rest of the day (Harare time) once this much is spent. */
  dailyUsd: number;
  /** Claude calls one WhatsApp number can cause per day. */
  perNumberPerDay: number;
  alerts?: Alerts;
  log: Logger;
  now: () => Date;
}

/**
 * Keeps Claude spending inside a daily budget. Every call is recorded with its cost; before a
 * call, `allows` checks the day's spend and the person's own count. Over either limit the app
 * carries on without Claude (local understanding, then people), never in silence.
 */
export class ClaudeBudget implements UsageMeter {
  private readonly alerted = new Set<string>();

  constructor(private readonly opts: ClaudeBudgetOptions) {}

  async allows(contactId?: string): Promise<boolean> {
    const { spent, mine } = await this.today(contactId);
    if (spent >= this.opts.dailyUsd) {
      this.alertOnce("100", `Claude's daily budget ($${this.opts.dailyUsd}) is used up. Until tomorrow, requests are understood locally or go to the team.`);
      return false;
    }
    return !contactId || mine < this.opts.perNumberPerDay;
  }

  async record(feature: AiFeature, model: string, usage: Usage, contactId?: string, opts: { batch?: boolean } = {}): Promise<void> {
    const cost = costOf(model, usage, opts);
    await this.opts.db.query(
      `INSERT INTO ai_usage (feature, model, contact_id, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        feature,
        model,
        contactId ?? null,
        usage.input_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        usage.output_tokens,
        cost,
        this.opts.now(),
      ],
    );
    const { spent } = await this.today();
    if (spent >= 0.8 * this.opts.dailyUsd) {
      this.alertOnce("80", `Claude spend today is $${spent.toFixed(2)}, over 80% of the $${this.opts.dailyUsd} daily budget.`);
    }
  }

  /** Spend since midnight in Harare, and how many calls this person caused. */
  async today(contactId?: string): Promise<{ spent: number; mine: number; calls: number }> {
    const [row] = await this.opts.db.query<{ spent: number; mine: number; calls: number }>(
      `SELECT COALESCE(sum(cost_usd), 0)::float8 AS spent, count(*)::int AS calls,
              count(*) FILTER (WHERE contact_id = $2)::int AS mine
         FROM ai_usage WHERE created_at >= $1`,
      [harareStartOfDay(this.opts.now()), contactId ?? null],
    );
    return row ?? { spent: 0, mine: 0, calls: 0 };
  }

  private alertOnce(level: string, text: string): void {
    const key = `${level}:${harareStartOfDay(this.opts.now()).toISOString()}`;
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    this.opts.alerts?.send(`claude-budget-${level}`, text);
    this.opts.log.warn({ level }, text);
  }
}
