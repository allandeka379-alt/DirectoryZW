import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { searchTokens } from "../text.js";
import type { ClaudeBudget } from "./budget.js";
import type { KeywordInterpreter } from "./keyword-interpreter.js";
import { analyzeLocally, type Band, type LocalAnalysis } from "./local.js";
import { fromPhrasebook, recall, remember, signatureOf } from "./phrasebook.js";
import type { InterpretContext, RequestInterpretation } from "./types.js";

/** Where an understanding came from. */
export type UnderstoodBy = "local" | "phrasebook" | "claude" | "fallback";

export interface ReaderContext extends InterpretContext {
  /** Who is asking, for per-number limits and cost records. */
  contactId?: string;
  /** What the local engine noticed, passed to Claude so it has less to work out. */
  notes?: string[];
}

/** Something that reads requests the local engine couldn't: Claude. Null means it couldn't either. */
export interface RequestReader {
  readonly name: string;
  interpretRequest(text: string, ctx: ReaderContext): Promise<RequestInterpretation | null>;
}

export interface Understanding {
  interpretation: RequestInterpretation;
  by: UnderstoodBy;
  band: Band;
  reasons: string[];
}

export interface UnderstanderOptions {
  db: Db;
  local: KeywordInterpreter;
  /** Optional: without it everything is understood locally. */
  claude?: RequestReader;
  budget?: ClaudeBudget;
  log: Logger;
}

/**
 * The understanding ladder. The local engine answers what it's sure of; wording seen before is
 * answered from the phrasebook; Claude reads the rest, within budget, and its answers are kept
 * so the same wording never costs twice. What nobody understood comes back as the local reading
 * marked "fallback", and the conversation hands it to a person.
 */
export class Understander {
  constructor(private readonly opts: UnderstanderOptions) {}

  /** For status pages: "local" or "local, then claude-sonnet-5". */
  get description(): string {
    return this.opts.claude ? `local, then ${this.opts.claude.name}` : "local only";
  }

  async understand(text: string, ctx: ReaderContext): Promise<Understanding> {
    const local = await analyzeLocally(text, ctx, this.opts.local);
    if (local.band === "high") return { interpretation: local.interpretation, by: "local", band: "high", reasons: local.reasons };

    const signature = signatureOf(text, ctx.gazetteer);
    if (signature) {
      const known = await recall(this.opts.db, signature);
      if (known) {
        return {
          interpretation: fromPhrasebook(known, local.interpretation),
          by: "phrasebook",
          band: local.band,
          reasons: [...local.reasons, `remembered from ${known.source}`],
        };
      }
    }

    const { claude, budget } = this.opts;
    if (claude && worthAsking(text) && (!budget || (await budget.allows(ctx.contactId)))) {
      const read = await claude.interpretRequest(text, { ...ctx, notes: notesFor(local) });
      if (read) {
        if (signature) await remember(this.opts.db, signature, read, "claude");
        return { interpretation: read, by: "claude", band: local.band, reasons: local.reasons };
      }
    }
    this.opts.log.info({ band: local.band, reasons: local.reasons }, "Request not understood beyond the local reading");
    return { interpretation: local.interpretation, by: "fallback", band: local.band, reasons: local.reasons };
  }
}

/** Claude is only worth paying for when there are words to read. */
function worthAsking(text: string): boolean {
  return text.length <= 1000 && searchTokens(text).length > 0;
}

function notesFor(local: LocalAnalysis): string[] {
  const notes = [
    `Possible categories: ${local.candidates.join(", ") || "none"}`,
    `Words not recognised: ${local.unknown.join(", ") || "none"}`,
  ];
  if (local.interpretation.area) notes.push(`Place mentioned: ${local.interpretation.area}`);
  return notes;
}
