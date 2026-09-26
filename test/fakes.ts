import type { RequestInterpretation } from "../src/ai/types.js";
import type { ReaderContext, RequestReader } from "../src/ai/understanding.js";

export function interpretation(fields: Partial<RequestInterpretation>): RequestInterpretation {
  return {
    intent: "search",
    category_slug: null,
    query: "",
    area: null,
    budget_usd: null,
    needed_by: null,
    clarifying_question: null,
    language: "en",
    ...fields,
  };
}

/** Stands in for Claude reading requests: answers come from the test, and every call is counted. */
export class FakeClaude implements RequestReader {
  readonly name = "fake-claude";
  readonly calls: { text: string; notes?: string[]; contactId?: string }[] = [];
  answer: (text: string) => RequestInterpretation | null = () => null;

  async interpretRequest(text: string, ctx: ReaderContext): Promise<RequestInterpretation | null> {
    this.calls.push({ text, notes: ctx.notes, contactId: ctx.contactId });
    return this.answer(text);
  }
}
