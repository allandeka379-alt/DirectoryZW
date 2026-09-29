import type { Alerts } from "../alerts.js";
import type { ClaudeBudget } from "../ai/budget.js";
import type { WordShapeClassifier } from "../ai/classifier.js";
import type { KeywordInterpreter } from "../ai/keyword-interpreter.js";
import type { Lexicon } from "../ai/lexicon.js";
import type { Understander } from "../ai/understanding.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { FileStore } from "../storage.js";
import type { PhotoFetcher } from "../web/photo-links.js";
import type { CatalogClient } from "../whatsapp/catalog.js";
import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { InboundMessage } from "../whatsapp/types.js";
import type { Messenger } from "./messenger.js";
import type { Contact } from "./store.js";

export interface Services {
  db: Db;
  config: Config;
  taxonomy: Taxonomy;
  gazetteer: Gazetteer;
  /** What words mean to the local engine; rebuilt when words or categories change. */
  lexicon: Lexicon;
  /** A second opinion from word shapes; retrained as the engine learns (see learning.ts). */
  classifier?: WordShapeClassifier;
  /** Reads requests: locally first, then the phrasebook, then Claude within budget. */
  understanding: Understander;
  /** The local keyword engine, for classifying business descriptions and tips (never Claude). */
  keywords: KeywordInterpreter;
  /** Daily limit on Claude spending. */
  budget: ClaudeBudget;
  messenger: Messenger;
  jobs: JobQueue;
  /** Field agents' photos of businesses. */
  store: FileStore;
  /** Our WhatsApp product catalog, when there is one (the simulator keeps its own). */
  catalog?: CatalogClient;
  /** Fetches a product photo from a link in an upload (only from the public internet). */
  fetchPhoto: PhotoFetcher;
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
  /** Run after the turn is saved, e.g. deleting everything about this person at their request. */
  defer(fn: () => Promise<void>): void;
}
