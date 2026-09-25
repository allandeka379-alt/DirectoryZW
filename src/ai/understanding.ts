import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { searchTokens } from "../text.js";
import type { ClaudeBudget } from "./budget.js";
import type { KeywordInterpreter } from "./keyword-interpreter.js";
import { analyzeLocally, type Band, type LocalAnalysis } from "./local.js";
import { fromPhrasebook, lookup, markUsed, remember, signatureOf, type PhraseEntry } from "./phrasebook.js";
import type { InterpretContext, RequestInterpretation } from "./types.js";

/** Where an understanding came from. "customer": they picked it from our "Did you mean…?" question. */
export type UnderstoodBy = "local" | "phrasebook" | "customer" | "claude" | "fallback";

export interface ReaderContext extends InterpretContext {
  /** Who is asking, for per-number limits and cost records. */
  contactId?: string;
  /** What the local engine noticed, passed to Claude so it has less to work out. */
  notes?: string[];
  /** Don't offer choices: the customer already said it's none of them. */
  noAsk?: boolean;
  /** Categories the customer ruled out by tapping "Something else". */
  exclude?: string[];
}

/** Something that reads requests the local engine couldn't: Claude. Null means it couldn't either. */
export interface RequestReader {
  readonly name: string;
  interpretRequest(text: string, ctx: ReaderContext): Promise<RequestInterpretation | null>;
}

/** What the local engine made of a request, kept with it for the team. */
export interface ReadingSummary {
  band: Band;
  candidates: string[];
  unknown: string[];
  reasons: string[];
}

export interface Understanding {
  interpretation: RequestInterpretation;
  by: UnderstoodBy;
  band: Band;
  reasons: string[];
  /** When set, ask the customer which of these categories they mean before searching. */
  options?: string[];
  /** The wording's phrasebook key, to remember the customer's answer under. */
  signature: string | null;
  reading: ReadingSummary;
}

export interface UnderstanderOptions {
  db: Db;
  local: KeywordInterpreter;
  /** Optional: without it, what the engine can't read goes to a question or a person. */
  claude?: RequestReader;
  budget?: ClaudeBudget;
  log: Logger;
}

/**
 * The understanding ladder:
 * 1. the local engine answers what it's sure of (a person's correction in the phrasebook still wins)
 * 2. wording seen before is answered from the phrasebook
 * 3. when one to three categories fit, the customer is asked which ("Did you mean…?")
 * 4. Claude reads the rest, within budget; its answers are kept so the same wording never costs twice
 * 5. what nobody understood comes back marked "fallback", and the conversation hands it to a person
 */
export class Understander {
  constructor(private readonly opts: UnderstanderOptions) {}

  /** For status pages: "local" or "local, then claude-sonnet-5". */
  get description(): string {
    return this.opts.claude ? `local, then ${this.opts.claude.name}` : "local only";
  }

  async understand(text: string, ctx: ReaderContext): Promise<Understanding> {
    const { db, log } = this.opts;
    const local = await analyzeLocally(text, ctx, this.opts.local);
    const signature = signatureOf(local.reading);
    const reading: ReadingSummary = { band: local.band, candidates: local.candidates, unknown: local.unknown, reasons: local.reasons };
    const exclude = new Set(ctx.exclude ?? []);
    const allowed = (slug: string | null | undefined) => !slug || !exclude.has(slug);
    const answer = (interpretation: RequestInterpretation, by: UnderstoodBy, reasons = local.reasons, options?: string[]): Understanding => ({
      interpretation,
      by,
      band: local.band,
      reasons,
      options,
      signature,
      reading,
    });
    const remembered = async (entry: PhraseEntry) => {
      await markUsed(db, entry.signature);
      return answer(fromPhrasebook(entry, local.interpretation), "phrasebook", [...local.reasons, `remembered from ${entry.source}`]);
    };

    const known = signature ? await lookup(db, signature) : undefined;
    const usable = known && allowed(known.category_slug) ? known : undefined;
    // A person's correction beats everything, even a confident local reading.
    if (usable?.source === "team") return remembered(usable);
    if (local.band === "high" && allowed(local.interpretation.category_slug)) return answer(local.interpretation, "local");
    if (usable) return remembered(usable);

    const options = local.options.filter(allowed);
    if (local.band === "medium" && options.length && !ctx.noAsk) return answer(local.interpretation, "local", local.reasons, options);

    const { claude, budget } = this.opts;
    if (claude && worthAsking(text) && (!budget || (await budget.allows(ctx.contactId)))) {
      const read = await claude.interpretRequest(text, { ...ctx, notes: notesFor(local, [...exclude]) });
      if (read && allowed(read.category_slug)) {
        if (signature) await remember(db, signature, read, "claude");
        return answer(read, "claude");
      }
    }
    log.info({ band: local.band, reasons: local.reasons }, "Request not understood beyond the local reading");
    return answer(local.interpretation, "fallback");
  }
}

/** Claude is only worth paying for when there are words to read. */
function worthAsking(text: string): boolean {
  return text.length <= 1000 && searchTokens(text).length > 0;
}

function notesFor(local: LocalAnalysis, excluded: string[]): string[] {
  const notes = [
    `Possible categories: ${local.candidates.join(", ") || "none"}`,
    `Words not recognised: ${local.unknown.join(", ") || "none"}`,
  ];
  if (local.interpretation.area) notes.push(`Place mentioned: ${local.interpretation.area}`);
  if (excluded.length) notes.push(`The customer said they don't mean: ${excluded.join(", ")}`);
  return notes;
}
