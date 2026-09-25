import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Logger } from "../logger.js";
import { normalizeZimPhone } from "../text.js";
import { onlineFinderSystemPrompt, onlineFinderUserMessage } from "./prompts.js";
import { describeError } from "./vision.js";

export interface OnlineSearch {
  /** What the customer wants, e.g. "wedding cake". */
  query: string;
  categoryName: string | null;
  /** "Avondale, Harare", or null to search the whole country. */
  place: string | null;
  city: string | null;
}

/** A business seen on the web. Nobody has checked it. */
export interface FoundBusiness {
  name: string;
  /** Zimbabwe mobile number, digits only: "2637XXXXXXXX". */
  phone: string;
  description: string;
  area: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
}

/** Looks for businesses on the web when the directory has nothing. */
export interface OnlineFinder {
  find(q: OnlineSearch): Promise<FoundBusiness[]>;
}

const REPORT_TOOL = "report_businesses";

const ReportSchema = z.object({
  businesses: z.array(
    z.object({
      name: z.string(),
      phone: z.string(),
      what_they_offer: z.string(),
      area: z.string().nullable(),
      source_url: z.string(),
    }),
  ),
});

const REPORT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    businesses: {
      type: "array",
      description: "Up to 5 businesses, best match first. Empty when nothing suitable was found.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Business name as shown." },
          phone: { type: "string", description: "Zimbabwe mobile number as shown in the search result." },
          what_they_offer: { type: "string", description: "One short line: what they sell or do." },
          area: { anyOf: [{ type: "string" }, { type: "null" }], description: "Suburb or town, if shown." },
          source_url: { type: "string", description: "URL of the search result that shows the name and number." },
        },
        required: ["name", "phone", "what_they_offer", "area", "source_url"],
        additionalProperties: false,
      },
    },
  },
  required: ["businesses"],
  additionalProperties: false,
};

const MAX_RESULTS = 5;
const MAX_CONTINUATIONS = 3;
/** Zimbabwe mobile networks: NetOne 071, Telecel 073, Econet 077 and 078. */
const ZIM_MOBILE = /^2637[1378]\d{7}$/;

export interface ClaudeOnlineFinderOptions {
  client: Anthropic;
  model: string;
  brand: string;
  log: Logger;
}

/**
 * Claude with the web search tool. Claude reports what it found through a strict tool, and
 * every result is checked here: the number must be a Zimbabwe mobile number and the source
 * must be one of the pages the search actually returned.
 */
export class ClaudeOnlineFinder implements OnlineFinder {
  constructor(private readonly opts: ClaudeOnlineFinderOptions) {}

  async find(q: OnlineSearch): Promise<FoundBusiness[]> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: onlineFinderUserMessage(q) }];
    const sources = new Map<string, string | null>();
    try {
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        const response = await this.opts.client.messages.create({
          model: this.opts.model,
          max_tokens: 8000,
          system: onlineFinderSystemPrompt(this.opts.brand),
          tools: [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: 3,
              user_location: { type: "approximate", country: "ZW", city: q.city, timezone: "Africa/Harare" },
            },
            {
              name: REPORT_TOOL,
              description: "Report the businesses you found. Call it exactly once, after searching.",
              strict: true,
              input_schema: REPORT_INPUT_SCHEMA,
            },
          ],
          messages,
          output_config: { effort: "low" },
        });
        collectSources(response.content, sources);
        const report = response.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REPORT_TOOL,
        );
        if (report) return checkReport(report.input, sources, this.opts.log);
        // The server paused a long search; send the turn back and it carries on.
        if (response.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: response.content });
          continue;
        }
        this.opts.log.warn({ stopReason: response.stop_reason }, "Online search ended without a report");
        return [];
      }
      this.opts.log.warn({}, "Online search kept pausing; giving up");
      return [];
    } catch (err) {
      this.opts.log.error({ err: describeError(err) }, "Online search failed");
      return [];
    }
  }
}

/** Keep only well-formed results with a real Zimbabwe mobile number and a source the search returned. */
export function checkReport(input: unknown, sources: Map<string, string | null>, log?: Logger): FoundBusiness[] {
  const parsed = ReportSchema.safeParse(input);
  if (!parsed.success) {
    log?.warn({ issues: parsed.error.issues.length }, "Online search report didn't match the schema");
    return [];
  }
  const seenHosts = new Set([...sources.keys()].map(hostOf).filter((h): h is string => !!h));
  const out: FoundBusiness[] = [];
  const phones = new Set<string>();
  for (const b of parsed.data.businesses) {
    const phone = normalizeZimPhone(b.phone);
    if (!phone || !ZIM_MOBILE.test(phone) || phones.has(phone)) continue;
    const host = hostOf(b.source_url);
    if (!host || !seenHosts.has(host)) continue;
    const name = oneLine(b.name, 60);
    if (name.length < 2) continue;
    phones.add(phone);
    out.push({
      name,
      phone,
      description: oneLine(b.what_they_offer, 120),
      area: b.area ? oneLine(b.area, 60) || null : null,
      sourceUrl: b.source_url.slice(0, 500),
      sourceTitle: sources.get(b.source_url) ?? null,
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Every URL anywhere in the response (search results, citations), with its page title when given. */
export function collectSources(value: unknown, into: Map<string, string | null>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectSources(v, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) {
    const title = typeof obj.title === "string" ? oneLine(obj.title, 120) || null : null;
    if (!into.get(obj.url)) into.set(obj.url, title);
  }
  for (const v of Object.values(obj)) if (v && typeof v === "object") collectSources(v, into);
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
