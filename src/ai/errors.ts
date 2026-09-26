import Anthropic from "@anthropic-ai/sdk";
import type { Alerts } from "../alerts.js";

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "invalid API key";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** A rejected key or an empty balance stops every Claude feature at once, so tell the team. */
export function alertOnClaudeError(err: unknown, alerts?: Alerts): void {
  if (!alerts) return;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    alerts.send("claude-auth", "Claude rejected the API key. Requests are understood locally, or go to the team, until ANTHROPIC_API_KEY is fixed.");
  } else if (err instanceof Anthropic.APIError && /credit balance|billing/i.test(err.message)) {
    alerts.send("claude-billing", "Claude calls are failing for billing reasons. Check the Anthropic Console.");
  }
}
