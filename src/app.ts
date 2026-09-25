import Anthropic from "@anthropic-ai/sdk";
import { WebhookAlerts, type Alerts } from "./alerts.js";
import { ClaudeBudget } from "./ai/budget.js";
import { ClaudeInterpreter } from "./ai/claude-interpreter.js";
import { GoogleSpeechToText, loadServiceAccount } from "./ai/google-speech.js";
import { KeywordInterpreter } from "./ai/keyword-interpreter.js";
import { trainClassifier } from "./ai/learning.js";
import { Lexicon } from "./ai/lexicon.js";
import { ClaudePriceListBatches, type PriceListBatches } from "./ai/price-list-batch.js";
import { HttpSpeechToText, SimulatorSpeechToText, type SpeechToText } from "./ai/speech.js";
import { Understander, type RequestReader } from "./ai/understanding.js";
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
import { DiskStore, S3Store, type FileStore } from "./storage.js";
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
  /** Re-read the lexicon after words are added, approved or rejected. */
  reloadLexicon(): Promise<void>;
  /** Relearn the classifier from what's known now (after teaching, labelling, new words). */
  retrainClassifier(): Promise<void>;
  close(): Promise<void>;
}

export interface AppOptions {
  db?: Db;
  transport?: Transport;
  store?: FileStore;
  media?: MediaSource;
  alerts?: Alerts;
  /** Pass null to switch a feature off even when it is configured. */
  claude?: RequestReader | null;
  vision?: Vision | null;
  priceListBatches?: PriceListBatches | null;
  speech?: SpeechToText | null;
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
  const lexiconOptions = { trustDrafts: config.lexiconTrustDrafts };
  const lexicon = await Lexicon.load(db, taxonomy, lexiconOptions);

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

  const alerts = opts.alerts ?? new WebhookAlerts({ webhookUrl: config.alertWebhookUrl, brand: config.brandName, log, now });
  const budget = new ClaudeBudget({ db, ...config.claudeBudget, alerts, log, now });
  const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : undefined;
  const claudeOpts = client ? { client, model: config.claudeModel, brand: config.brandName, log, alerts, meter: budget } : undefined;
  const keywords = new KeywordInterpreter();
  const claude = pick(opts.claude, () => (claudeOpts ? new ClaudeInterpreter(claudeOpts) : undefined));
  const understanding = new Understander({ db, local: keywords, claude, budget, log, settings: config.local });
  const vision = pick(opts.vision, () => (claudeOpts ? new ClaudeVision(claudeOpts) : undefined));
  const priceListBatches = pick(opts.priceListBatches, () =>
    client && config.priceListBatch ? new ClaudePriceListBatches({ client, model: config.claudeModel, meter: budget }) : undefined,
  );
  const speech = pick(opts.speech, () => {
    const google = config.speech.google;
    if (google) {
      return new GoogleSpeechToText({
        projectId: google.projectId,
        location: google.location,
        languages: google.languages,
        credentials: loadServiceAccount(google.credentialsFile, google.credentialsJson),
      });
    }
    if (config.speech.url) return new HttpSpeechToText({ url: config.speech.url, token: config.speech.token, languages: config.speech.languages });
    // In the simulator, a voice note carries the words typed when it was sent.
    return simulatorMedia ? new SimulatorSpeechToText(simulatorMedia) : undefined;
  });
  const store = opts.store ?? (config.storage.driver === "s3" ? await S3Store.create(config.storage) : new DiskStore(config.uploadsDir));
  if (config.env === "production" && store.name === "disk") {
    log.warn({ dir: config.uploadsDir }, "Photos are stored on local disk; make sure it survives redeploys, or set STORAGE=s3");
  }

  const jobs = new JobQueue(db, log, now, (job, error) =>
    alerts.send(`job:${job.kind}`, `Background job "${job.kind}" failed ${job.attempts} times: ${error.slice(0, 200)}`),
  );
  const messenger = new Messenger(db, transport, config, log, { now, jobs, alerts });
  const services: Services = {
    db,
    config,
    taxonomy,
    gazetteer,
    lexicon,
    understanding,
    keywords,
    budget,
    messenger,
    jobs,
    media,
    store,
    vision,
    priceListBatches,
    speech,
    alerts,
    log,
    now,
  };
  async function retrainClassifier(): Promise<void> {
    if (config.local.classifierMin > 0) services.classifier = await trainClassifier({ ...services, db });
  }
  await retrainClassifier();
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
      services.lexicon = services.lexicon.withTaxonomy(services.taxonomy);
      await retrainClassifier();
    },
    reloadLexicon: async () => {
      services.lexicon = await Lexicon.load(db, services.taxonomy, lexiconOptions);
      await retrainClassifier();
    },
    retrainClassifier,
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
