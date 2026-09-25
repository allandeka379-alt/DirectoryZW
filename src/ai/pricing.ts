/** What one API call reports it used. `input_tokens` excludes tokens read from or written to the cache. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * US dollars per million tokens, from claude.com/pricing on 25 September 2026. Cache reads cost
 * `cacheRead` times the input price and 5-minute cache writes 1.25 times. Longer prefixes first.
 */
const PRICES: { prefix: string; input: number; output: number; cacheRead: number }[] = [
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.05 },
  { prefix: "claude-opus-5", input: 5, output: 25, cacheRead: 0.1 },
  { prefix: "claude-opus-4", input: 5, output: 25, cacheRead: 0.1 },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.1 },
  { prefix: "claude-sonnet-4", input: 3, output: 15, cacheRead: 0.1 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1 },
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.025 },
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 0.1 },
];

/** An unknown model is priced like Opus, so the budget errs on the safe side. */
const UNKNOWN = { input: 5, output: 25, cacheRead: 0.1 };

export function costOf(model: string, usage: Usage): number {
  const p = PRICES.find((x) => model.startsWith(x.prefix)) ?? UNKNOWN;
  const dollars =
    usage.input_tokens * p.input +
    (usage.cache_read_input_tokens ?? 0) * p.input * p.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
    usage.output_tokens * p.output;
  return dollars / 1_000_000;
}
