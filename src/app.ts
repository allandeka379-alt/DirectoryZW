import Anthropic from "@anthropic-ai/sdk";
import { WebhookAlerts, type Alerts } from "./alerts.js";
import { ClaudeBudget } from "./ai/budget.js";
import { ClaudeInterpreter } from "./ai/claude-interpreter.js";
import { KeywordInterpreter } from "./ai/keyword-interpreter.js";
import { trainClassifier } from "./ai/learning.js";
import { Lexicon } from "./ai/lexicon.js";
import { Understander, type RequestReader } from "./ai/understanding.js";
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
import { fetchPhotoLink, type PhotoFetcher } from "./web/photo-links.js";
import { GraphCatalog, MemoryCatalog, type CatalogClient } from "./whatsapp/catalog.js";
import { CloudApiTransport, OffTransport, SimulatorTransport, type Transport } from "./whatsapp/transport.js";

export interface App {
  config: Config;
  db: Db;
  services: Services;
  engine: ConversationEngine;
  transport: Transport;
  /** Present when messages stay local instead of going to Meta. */
  simulator?: SimulatorTransport;
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
  alerts?: Alerts;
  /** Pass null to switch Claude off even when it is configured. */
  claude?: RequestReader | null;
  /** The WhatsApp catalog; pass null for none. By default Meta's (WHATSAPP_CATALOG_ID) or the simulator's. */
  catalog?: CatalogClient | null;
  /** Fetches photos from the links in product uploads; tests pass one that never goes online. */
  fetchPhoto?: PhotoFetcher;
  log?: Logger;
  now?: () => Date;
}

/** Wire the whole app together. Tests pass an in-memory database, the simulator and a fixed clock. */
export async function createApp(config: Config, opts: AppOptions = {}): Promise<App> {
  const log = opts.log ?? consoleLogger;
  const now = opts.now ?? (() => new Date());
  const db =
    opts.db ??
    (await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir, onError: (message, err) => log.error({ err: String(err) }, message) }));
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
          phoneNumberId: config.whatsapp.phoneNumberId,
          log,
        })
      : config.whatsapp.transport === "off"
        ? new OffTransport()
        : new SimulatorTransport());

  const alerts = opts.alerts ?? new WebhookAlerts({ webhookUrl: config.alertWebhookUrl, brand: config.brandName, log, now });
  const budget = new ClaudeBudget({ db, ...config.claudeBudget, alerts, log, now });
  // A customer is waiting on every call: a short timeout and one retry, not the SDK's ten minutes and two.
  const client = config.anthropicApiKey
    ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: config.claudeTimeoutMs, maxRetries: 1 })
    : undefined;
  const claudeOpts = client ? { client, model: config.claudeModel, brand: config.brandName, log, alerts, meter: budget, now } : undefined;
  const keywords = new KeywordInterpreter();
  const claude = pick(opts.claude, () => (claudeOpts ? new ClaudeInterpreter(claudeOpts) : undefined));
  const understanding = new Understander({ db, local: keywords, claude, budget, log, settings: config.local });
  const store = opts.store ?? (config.storage.driver === "s3" ? await S3Store.create(config.storage) : new DiskStore(config.uploadsDir));
  if (config.env === "production" && store.name === "disk") {
    log.warn({ dir: config.uploadsDir }, "Photos are stored on local disk; make sure it survives redeploys, or set STORAGE=s3");
  }

  const jobs = new JobQueue(db, log, now, (job, error) =>
    alerts.send(`job:${job.kind}`, `Background job "${job.kind}" failed ${job.attempts} times: ${error.slice(0, 200)}`),
  );
  const messenger = new Messenger(db, transport, config, log, { now, jobs, alerts });
  const catalogId = config.whatsapp.catalogId;
  const catalog = pick(opts.catalog, () =>
    !catalogId || config.whatsapp.transport === "off"
      ? undefined
      : cloud
        ? new GraphCatalog({ graphVersion: config.whatsapp.graphVersion, accessToken: config.whatsapp.accessToken!, catalogId, log })
        : new MemoryCatalog(catalogId),
  );
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
    store,
    catalog,
    fetchPhoto: opts.fetchPhoto ?? ((url) => fetchPhotoLink(url)),
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
