import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Alerts } from "../alerts.js";
import type { Logger } from "../logger.js";
import type { UsageMeter } from "./budget.js";
import { alertOnClaudeError, describeError } from "./errors.js";
import { requestSystemPrompt, requestUserMessage } from "./prompts.js";
import { RequestInterpretationSchema, sanitizeInterpretation, type RequestInterpretation } from "./types.js";
import type { ReaderContext, RequestReader } from "./understanding.js";

export interface ClaudeInterpreterOptions {
  client: Anthropic;
  model: string;
  brand: string;
  log: Logger;
  alerts?: Alerts;
  /** Records each call's cost against the daily budget. */
  meter?: UsageMeter;
  now?: () => Date;
}

/** After this many failed calls in a row, Claude is skipped for a while (see BREAK_FOR_MS). */
const BREAK_AFTER = 3;
/** How long Claude is skipped after repeated failures, so customers don't each wait for a timeout. */
const BREAK_FOR_MS = 5 * 60_000;
/**
 * A cache write costs 1.25 times the price and only pays off if another call reads it within five
 * minutes. So the prompt is marked for caching only when the last call was this recent.
 */
const WARM_MS = 4 * 60_000;

/**
 * Claude reads the requests the local engine couldn't. It's a short classification, so thinking
 * is off and effort low, and the local engine's notes go in the message. The system prompt
 * (instructions and category list) is cached only while calls come close together. Returns null
 * when Claude refuses, fails or gives nothing usable, and the conversation carries on without it.
 * After three failures in a row, Claude is skipped for five minutes.
 */
export class ClaudeInterpreter implements RequestReader {
  private failures = 0;
  private skipUntil = 0;
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: ClaudeInterpreterOptions) {}

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  get name(): string {
    return this.opts.model;
  }

  async interpretRequest(text: string, ctx: ReaderContext): Promise<RequestInterpretation | null> {
    const now = this.now();
    if (now < this.skipUntil) return null;
    const warm = now - this.lastCallAt < WARM_MS;
    this.lastCallAt = now;
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 1000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "disabled" },
        system: [
          { type: "text", text: requestSystemPrompt(this.opts.brand, ctx.taxonomy), ...(warm ? { cache_control: { type: "ephemeral" as const } } : {}) },
        ],
        messages: [{ role: "user", content: requestUserMessage(text, ctx.previousRequest, ctx.notes) }],
        output_config: { effort: "low", format: betaZodOutputFormat(RequestInterpretationSchema) },
      });
      this.failures = 0;
      await this.opts.meter?.record("request", response.model, response.usage, ctx.contactId);
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        this.opts.log.warn({ stopReason: response.stop_reason }, "Claude returned no interpretation");
        return null;
      }
      return sanitizeInterpretation(response.parsed_output, ctx.taxonomy);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Claude request failed");
      alertOnClaudeError(err, this.opts.alerts);
      if (++this.failures >= BREAK_AFTER) {
        this.failures = 0;
        this.skipUntil = this.now() + BREAK_FOR_MS;
        this.opts.alerts?.send(
          "claude-break",
          `Claude failed ${BREAK_AFTER} times in a row, so it's skipped for 5 minutes: requests are understood locally or go to the team.`,
        );
      }
      return null;
    }
  }
}
