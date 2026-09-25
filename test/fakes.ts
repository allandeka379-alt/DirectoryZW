import type { BatchRead, PriceListBatches } from "../src/ai/price-list-batch.js";
import type { InterpretContext, RequestInterpretation } from "../src/ai/types.js";
import type { ReaderContext, RequestReader } from "../src/ai/understanding.js";
import type { PriceList, Vision } from "../src/ai/vision.js";
import type { Media } from "../src/whatsapp/media.js";

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

/** Stands in for Claude vision: answers come from the test. */
export class FakeVision implements Vision {
  readonly photos: { caption?: string; image: Media }[] = [];
  readonly priceLists: Media[] = [];
  photoAnswer: (caption: string | undefined) => RequestInterpretation | null = () => null;
  priceListAnswer: PriceList | null = null;

  async interpretPhoto(image: Media, caption: string | undefined, _ctx: InterpretContext): Promise<RequestInterpretation | null> {
    this.photos.push({ caption, image });
    return this.photoAnswer(caption);
  }

  async readPriceList(image: Media): Promise<PriceList | null> {
    this.priceLists.push(image);
    return this.priceListAnswer;
  }
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

/** Stands in for the Batch API: batches finish when the test says so, with the answers it sets. */
export class FakePriceListBatches implements PriceListBatches {
  readonly submitted: { batchId: string; photoIds: string[] }[] = [];
  answer: (photoId: string) => BatchRead = (photoId) => ({ photoId, list: null, error: "no answer set" });
  private readonly finished = new Set<string>();

  async submit(photos: { photoId: string; image: Media }[]): Promise<string> {
    const batchId = `batch-${this.submitted.length + 1}`;
    this.submitted.push({ batchId, photoIds: photos.map((p) => p.photoId) });
    return batchId;
  }

  finish(batchId: string): void {
    this.finished.add(batchId);
  }

  async collect(batchId: string): Promise<BatchRead[] | undefined> {
    if (!this.finished.has(batchId)) return undefined;
    return this.submitted.find((b) => b.batchId === batchId)!.photoIds.map((id) => this.answer(id));
  }
}
