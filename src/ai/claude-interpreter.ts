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
}

/**
 * Claude reads the requests the local engine couldn't. It's a short classification, so thinking
 * is off and effort low; the system prompt (instructions and category list) is cached, and the
 * local engine's notes go in the message. Returns null when Claude refuses, fails or gives nothing
 * usable, and the conversation carries on without it.
 */
export class ClaudeInterpreter implements RequestReader {
  constructor(private readonly opts: ClaudeInterpreterOptions) {}

  get name(): string {
    return this.opts.model;
  }

  async interpretRequest(text: string, ctx: ReaderContext): Promise<RequestInterpretation | null> {
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 1000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "disabled" },
        system: [
          { type: "text", text: requestSystemPrompt(this.opts.brand, ctx.taxonomy), cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: requestUserMessage(text, ctx.previousRequest, ctx.notes) }],
        output_config: { effort: "low", format: betaZodOutputFormat(RequestInterpretationSchema) },
      });
      await this.opts.meter?.record("request", response.model, response.usage, ctx.contactId);
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        this.opts.log.warn({ stopReason: response.stop_reason }, "Claude returned no interpretation");
        return null;
      }
      return sanitizeInterpretation(response.parsed_output, ctx.taxonomy);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Claude request failed");
      alertOnClaudeError(err, this.opts.alerts);
      return null;
    }
  }
}
