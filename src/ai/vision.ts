import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { Media } from "../whatsapp/media.js";
import { photoSystemPrompt, photoUserMessage, priceListSystemPrompt } from "./prompts.js";
import {
  RequestInterpretationSchema,
  sanitizeInterpretation,
  type InterpretContext,
  type RequestInterpretation,
} from "./types.js";

export const PriceListSchema = z.object({
  is_price_list: z.boolean(),
  items: z.array(
    z.object({
      name: z.string(),
      price_usd: z.number().nullable(),
      price_text: z.string().nullable(),
    }),
  ),
});
export type PriceList = z.infer<typeof PriceListSchema>;
export type PriceListItem = PriceList["items"][number];

/** Reads photos. Like the interpreter, it only describes; the database decides what exists. */
export interface Vision {
  /** What a customer is looking for, from a photo and its caption. Null when the photo can't be used. */
  interpretPhoto(image: Media, caption: string | undefined, ctx: InterpretContext): Promise<RequestInterpretation | null>;
  /** Items and prices from a photo of a price list or menu. Null when reading failed. */
  readPriceList(image: Media): Promise<PriceList | null>;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
/** Claude accepts images up to 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isReadableImage(image: Media): image is Media & { mimeType: ImageType } {
  return (IMAGE_TYPES as readonly string[]).includes(image.mimeType) && image.data.length > 0 && image.data.length <= MAX_IMAGE_BYTES;
}

export interface ClaudeVisionOptions {
  client: Anthropic;
  model: string;
  brand: string;
  log: Logger;
}

/** Claude vision with structured output. Any failure returns null so the chat can ask for words instead. */
export class ClaudeVision implements Vision {
  constructor(private readonly opts: ClaudeVisionOptions) {}

  async interpretPhoto(image: Media, caption: string | undefined, ctx: InterpretContext): Promise<RequestInterpretation | null> {
    if (!isReadableImage(image)) return null;
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: photoSystemPrompt(this.opts.brand, ctx.taxonomy), cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") } },
              { type: "text", text: photoUserMessage(caption, ctx.previousRequest) },
            ],
          },
        ],
        output_config: { effort: "low", format: betaZodOutputFormat(RequestInterpretationSchema) },
      });
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        this.opts.log.warn({ stopReason: response.stop_reason }, "Claude couldn't read the customer's photo");
        return null;
      }
      return sanitizeInterpretation(response.parsed_output, ctx.taxonomy);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Photo request failed");
      return null;
    }
  }

  async readPriceList(image: Media): Promise<PriceList | null> {
    if (!isReadableImage(image)) return null;
    try {
      const response = await this.opts.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: priceListSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") } },
              { type: "text", text: "Read this price list." },
            ],
          },
        ],
        output_config: { effort: "low", format: betaZodOutputFormat(PriceListSchema) },
      });
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
        this.opts.log.warn({ stopReason: response.stop_reason }, "Claude couldn't read the price list");
        return null;
      }
      return sanitizePriceList(response.parsed_output);
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Price list request failed");
      return null;
    }
  }
}

/** Keep what we store short and plausible. */
export function sanitizePriceList(list: PriceList): PriceList {
  const seen = new Set<string>();
  const items: PriceListItem[] = [];
  for (const item of list.items) {
    const name = oneLine(item.name, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const usd = item.price_usd != null && Number.isFinite(item.price_usd) && item.price_usd > 0 && item.price_usd < 1_000_000 ? Math.round(item.price_usd * 100) / 100 : null;
    items.push({ name, price_usd: usd, price_text: item.price_text ? oneLine(item.price_text, 30) || null : null });
    if (items.length >= 100) break;
  }
  return { is_price_list: list.is_price_list && items.length > 0, items: list.is_price_list ? items : [] };
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "invalid API key";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
