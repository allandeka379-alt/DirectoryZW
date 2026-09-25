import Anthropic from "@anthropic-ai/sdk";
import { ClaudeInterpreter } from "./ai/claude-interpreter.js";
import { KeywordInterpreter } from "./ai/keyword-interpreter.js";
import { ClaudeOnlineFinder, type OnlineFinder } from "./ai/online-finder.js";
import { HttpSpeechToText, SimulatorSpeechToText, type SpeechToText } from "./ai/speech.js";
import type { Interpreter } from "./ai/types.js";
import { ClaudeVision, type Vision } from "./ai/vision.js";
import type { Config } from "./config.js";
import type { Services } from "./conversation/context.js";
import { ConversationEngine } from "./conversation/engine.js";
import { jobHandlers, scheduleRecurringJobs } from "./conversation/followups.js";
import { Messenger } from "./conversation/messenger.js";
import { openDb, type Db } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { seedReferenceData, seedSampleBusinesses } from "./db/seed.js";
import { Gazetteer } from "./directory/gazetteer.js";
import { Taxonomy } from "./directory/taxonomy.js";
import { JobQueue } from "./jobs/queue.js";
import { consoleLogger, type Logger } from "./logger.js";
import { DiskStore, type FileStore } from "./storage.js";
import { CloudMediaSource, SimulatorMediaSource, type MediaSource } from "./whatsapp/media.js";
import { CloudApiTransport, SimulatorTransport, type Transport } from "./whatsapp/transport.js";

export interface App {
  config: Config;
  db: Db;
  services: Services;
  engine: ConversationEngine;
  transport: Transport;
  /** Present when messages stay local instead of going to Meta. */
  simulator?: SimulatorTransport;
  /** Present when photos and voice notes come from the simulator. */
  simulatorMedia?: SimulatorMediaSource;
  /** Field photos and other uploads. */
  store: FileStore;
  runJobs(): Promise<number>;
  /** Re-read categories after synonyms change. */
  reloadTaxonomy(): Promise<void>;
  close(): Promise<void>;
}

export interface AppOptions {
  db?: Db;
  transport?: Transport;
  store?: FileStore;
  media?: MediaSource;
  interpreter?: Interpreter;
  /** Pass null to switch a feature off even when it is configured. */
  vision?: Vision | null;
  speech?: SpeechToText | null;
  finder?: OnlineFinder | null;
  log?: Logger;
  now?: () => Date;
}

/** Wire the whole app together. Tests pass an in-memory database, the simulator and a fixed clock. */
export async function createApp(config: Config, opts: AppOptions = {}): Promise<App> {
  const log = opts.log ?? consoleLogger;
  const now = opts.now ?? (() => new Date());
  const db = opts.db ?? (await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir }));
  await migrate(db);
  await seedReferenceData(db);
  if (config.seedSampleData) await seedSampleBusinesses(db);
  const [taxonomy, gazetteer] = await Promise.all([Taxonomy.load(db), Gazetteer.load(db)]);

  const cloud = config.whatsapp.transport === "cloud";
  const transport =
    opts.transport ??
    (cloud
      ? new CloudApiTransport({
          graphVersion: config.whatsapp.graphVersion,
          accessToken: config.whatsapp.accessToken!,
          phoneNumberIds: config.whatsapp.phoneNumberIds,
          log,
        })
      : new SimulatorTransport());
  const media =
    opts.media ??
    (cloud
      ? new CloudMediaSource({
          graphVersion: config.whatsapp.graphVersion,
          accessToken: config.whatsapp.accessToken!,
          maxBytes: config.maxMediaBytes,
        })
      : new SimulatorMediaSource());
  const simulatorMedia = media instanceof SimulatorMediaSource ? media : undefined;

  const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : undefined;
  const claude = client ? { client, model: config.claudeModel, brand: config.brandName, log } : undefined;
  const keywords = new KeywordInterpreter();
  const interpreter = opts.interpreter ?? (claude ? new ClaudeInterpreter({ ...claude, fallback: keywords }) : keywords);
  const vision = pick(opts.vision, () => (claude ? new ClaudeVision(claude) : undefined));
  const finder = pick(opts.finder, () => (claude && config.onlineSearch.enabled ? new ClaudeOnlineFinder(claude) : undefined));
  const speech = pick(opts.speech, () => {
    if (config.speech.url) return new HttpSpeechToText({ url: config.speech.url, token: config.speech.token, languages: config.speech.languages });
    // In the simulator, a voice note carries the words typed when it was sent.
    return simulatorMedia ? new SimulatorSpeechToText(simulatorMedia) : undefined;
  });
  const store = opts.store ?? new DiskStore(config.uploadsDir);

  const messenger = new Messenger(db, transport, config, log, now);
  const jobs = new JobQueue(db, log, now);
  const services: Services = {
    db,
    config,
    taxonomy,
    gazetteer,
    interpreter,
    messenger,
    jobs,
    media,
    store,
    vision,
    speech,
    finder,
    log,
    now,
  };
  const engine = new ConversationEngine(services);
  const handlers = jobHandlers(services);
  await scheduleRecurringJobs(services);

  return {
    config,
    db,
    services,
    engine,
    transport,
    simulator: transport instanceof SimulatorTransport ? transport : undefined,
    simulatorMedia,
    store,
    runJobs: () => jobs.runDue(handlers),
    reloadTaxonomy: async () => {
      services.taxonomy = await Taxonomy.load(db);
    },
    close: async () => {
      await engine.idle();
      await db.close();
    },
  };
}

/** An explicit option wins (null switches the feature off); otherwise build the default. */
function pick<T>(option: T | null | undefined, fallback: () => T | undefined): T | undefined {
  if (option === null) return undefined;
  return option ?? fallback();
}
