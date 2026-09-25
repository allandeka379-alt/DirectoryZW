import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Media } from "../whatsapp/media.js";
import type { UsageMeter } from "./budget.js";
import { priceListSystemPrompt } from "./prompts.js";
import { isReadableImage, PriceListSchema, sanitizePriceList, type PriceList } from "./vision.js";

/** What came back for one photo in a batch: a price list, or why there isn't one. */
export interface BatchRead {
  photoId: string;
  list: PriceList | null;
  /** Set when reading failed in a way worth retrying (an error or an expired request). */
  error?: string;
}

/**
 * Reads price-list photos through the Message Batches API: half the price of a normal call, with
 * results usually within an hour (24 at most). For field agents' photos, where nobody is waiting;
 * an owner's own photo is read straight away (see vision.ts).
 */
export interface PriceListBatches {
  /** Send photos off to be read. Returns the batch's ID. */
  submit(photos: { photoId: string; image: Media }[]): Promise<string>;
  /** The reads, once the batch has ended; undefined while it's still running. */
  collect(batchId: string): Promise<BatchRead[] | undefined>;
}

export interface ClaudePriceListBatchesOptions {
  client: Anthropic;
  model: string;
  /** Records each read's cost (at the batch price) against the daily budget. */
  meter?: UsageMeter;
}

export class ClaudePriceListBatches implements PriceListBatches {
  constructor(private readonly opts: ClaudePriceListBatchesOptions) {}

  async submit(photos: { photoId: string; image: Media }[]): Promise<string> {
    // The same request as an interactive read, without server-side fallbacks (the Batches API rejects them).
    const format = betaZodOutputFormat(PriceListSchema);
    const batch = await this.opts.client.messages.batches.create({
      requests: photos
        .filter(({ image }) => isReadableImage(image))
        .map(({ photoId, image }) => ({
          custom_id: photoId,
          params: {
            model: this.opts.model,
            max_tokens: 8000,
            thinking: { type: "disabled" as const },
            system: [{ type: "text" as const, text: priceListSystemPrompt(), cache_control: { type: "ephemeral" as const } }],
            messages: [
              {
                role: "user" as const,
                content: [
                  {
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: image.mimeType as "image/jpeg", data: image.data.toString("base64") },
                  },
                  { type: "text" as const, text: "Read this price list." },
                ],
              },
            ],
            output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: format.schema } },
          },
        })),
    });
    return batch.id;
  }

  async collect(batchId: string): Promise<BatchRead[] | undefined> {
    const batch = await this.opts.client.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") return undefined;
    const reads: BatchRead[] = [];
    for await (const item of await this.opts.client.messages.batches.results(batchId)) {
      const photoId = item.custom_id;
      const result = item.result;
      if (result.type !== "succeeded") {
        const why = result.type === "errored" ? `${result.error.error.type}: ${result.error.error.message}` : result.type;
        reads.push({ photoId, list: null, error: why });
        continue;
      }
      const message = result.message;
      await this.opts.meter?.record("price_list_batch", message.model, message.usage, undefined, { batch: true });
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens" || !text) {
        reads.push({ photoId, list: null, error: `stopped: ${message.stop_reason}` });
        continue;
      }
      try {
        const parsed = PriceListSchema.safeParse(JSON.parse(text));
        reads.push(parsed.success ? { photoId, list: sanitizePriceList(parsed.data) } : { photoId, list: null, error: "unreadable output" });
      } catch {
        reads.push({ photoId, list: null, error: "unreadable output" });
      }
    }
    return reads;
  }
}
