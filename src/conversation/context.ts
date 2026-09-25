import type { Interpreter } from "../ai/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { InboundMessage } from "../whatsapp/types.js";
import type { Messenger } from "./messenger.js";
import type { Contact } from "./store.js";

export interface Services {
  db: Db;
  config: Config;
  taxonomy: Taxonomy;
  gazetteer: Gazetteer;
  interpreter: Interpreter;
  messenger: Messenger;
  jobs: JobQueue;
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
}
