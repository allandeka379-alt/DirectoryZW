import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Logger } from "../logger.js";
import { businessSystemPrompt, requestSystemPrompt, requestUserMessage } from "./prompts.js";
import {
  BusinessClassificationSchema,
  RequestInterpretationSchema,
  sanitizeClassification,
  sanitizeInterpretation,
  type BusinessClassification,
  type InterpretContext,
  type Interpreter,
  type RequestInterpretation,
} from "./types.js";

export interface ClaudeInterpreterOptions {
  client: Anthropic;
  model: string;
  brand: string;
  /** Used when Claude errors, refuses, or returns nothing usable. */
  fallback: Interpreter;
  log: Logger;
}

/**
 * Structured-output interpreter on the Claude API. Low effort keeps latency and cost down;
 * the system prompt (instructions + category list) is cached. Server-side fallbacks re-run
 * a refused request on another model before we drop to the keyword interpreter.
 */
export class ClaudeInterpreter implements Interpreter {
  readonly name = "claude";

  constructor(private readonly opts: ClaudeInterpreterOptions) {}

  async interpretRequest(text: string, ctx: InterpretContext): Promise<RequestInterpretation> {
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: requestSystemPrompt(this.opts.brand, ctx.taxonomy), cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: requestUserMessage(text, ctx.previousRequest) }],
        output_config: { effort: "low", format: betaZodOutputFormat(RequestInterpretationSchema) },
      });
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        this.opts.log.warn({ stopReason: response.stop_reason }, "Claude returned no interpretation; using keywords");
        return this.opts.fallback.interpretRequest(text, ctx);
      }
      return sanitizeInterpretation(response.parsed_output, ctx.taxonomy);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Claude request failed; using keywords");
      return this.opts.fallback.interpretRequest(text, ctx);
    }
  }

  async classifyBusiness(text: string, ctx: InterpretContext): Promise<BusinessClassification> {
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: businessSystemPrompt(this.opts.brand, ctx.taxonomy), cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: `Business description:\n"""${text}"""` }],
        output_config: { effort: "low", format: betaZodOutputFormat(BusinessClassificationSchema) },
      });
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        return this.opts.fallback.classifyBusiness(text, ctx);
      }
      const result = sanitizeClassification(response.parsed_output, ctx.taxonomy);
      return result.category_slugs.length ? result : this.opts.fallback.classifyBusiness(text, ctx);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Claude classification failed; using keywords");
      return this.opts.fallback.classifyBusiness(text, ctx);
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "invalid API key";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
