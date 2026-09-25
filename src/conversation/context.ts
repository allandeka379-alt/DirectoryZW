import type { Alerts } from "../alerts.js";
import type { ClaudeBudget } from "../ai/budget.js";
import type { KeywordInterpreter } from "../ai/keyword-interpreter.js";
import type { SpeechToText } from "../ai/speech.js";
import type { Understander } from "../ai/understanding.js";
import type { Vision } from "../ai/vision.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { FileStore } from "../storage.js";
import type { MediaSource } from "../whatsapp/media.js";
import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { InboundMessage } from "../whatsapp/types.js";
import type { Messenger } from "./messenger.js";
import type { Contact } from "./store.js";

export interface Services {
  db: Db;
  config: Config;
  taxonomy: Taxonomy;
  gazetteer: Gazetteer;
  /** Reads requests: locally first, then the phrasebook, then Claude within budget. */
  understanding: Understander;
  /** The local keyword engine, for classifying business descriptions and tips (never Claude). */
  keywords: KeywordInterpreter;
  /** Daily limit on Claude spending, checked before photos and price lists too. */
  budget: ClaudeBudget;
  messenger: Messenger;
  jobs: JobQueue;
  /** Photos and voice notes people send. */
  media: MediaSource;
  /** Business photos and other uploads. */
  store: FileStore;
  /** Optional: reading photos needs Claude. */
  vision?: Vision;
  /** Optional: voice notes need a speech-to-text service. */
  speech?: SpeechToText;
  /** Tells the team when something needs a person. */
  alerts: Alerts;
  log: Logger;
  now: () => Date;
}

/** One inbound message being handled: who sent it, their saved state, and how to reply. */
export interface Turn<S> {
  svc: Services;
  contact: Contact;
  inbound: InboundMessage;
  state: S;
  reply(msg: OutboundMessage): Promise<void>;
  /** Put a line at the top of the next reply, instead of paying for a separate message. */
  prefixNext(line: string): void;
  /** Run after the turn is saved, e.g. deleting everything about this person at their request. */
  defer(fn: () => Promise<void>): void;
}
