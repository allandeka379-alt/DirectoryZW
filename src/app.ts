import Anthropic from "@anthropic-ai/sdk";
import { ClaudeInterpreter } from "./ai/claude-interpreter.js";
import { KeywordInterpreter } from "./ai/keyword-interpreter.js";
import type { Interpreter } from "./ai/types.js";
import type { Config } from "./config.js";
import type { Services } from "./conversation/context.js";
import { ConversationEngine } from "./conversation/engine.js";
import { jobHandlers } from "./conversation/followups.js";
import { Messenger } from "./conversation/messenger.js";
import { openDb, type Db } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { seedReferenceData, seedSampleBusinesses } from "./db/seed.js";
import { Gazetteer } from "./directory/gazetteer.js";
import { Taxonomy } from "./directory/taxonomy.js";
import { JobQueue } from "./jobs/queue.js";
import { consoleLogger, type Logger } from "./logger.js";
import { CloudApiTransport, SimulatorTransport, type Transport } from "./whatsapp/transport.js";

export interface App {
  config: Config;
  db: Db;
  services: Services;
  engine: ConversationEngine;
  transport: Transport;
  /** Present when messages stay local instead of going to Meta. */
  simulator?: SimulatorTransport;
  runJobs(): Promise<number>;
  close(): Promise<void>;
}

export interface AppOptions {
  db?: Db;
  transport?: Transport;
  interpreter?: Interpreter;
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

  const transport =
    opts.transport ??
    (config.whatsapp.transport === "cloud"
      ? new CloudApiTransport({
          graphVersion: config.whatsapp.graphVersion,
          accessToken: config.whatsapp.accessToken!,
          phoneNumberIds: config.whatsapp.phoneNumberIds,
          log,
        })
      : new SimulatorTransport());

  const keywords = new KeywordInterpreter();
  const interpreter =
    opts.interpreter ??
    (config.anthropicApiKey
      ? new ClaudeInterpreter({
          client: new Anthropic({ apiKey: config.anthropicApiKey }),
          model: config.claudeModel,
          brand: config.brandName,
          fallback: keywords,
          log,
        })
      : keywords);

  const messenger = new Messenger(db, transport, config, log, now);
  const jobs = new JobQueue(db, log, now);
  const services: Services = { db, config, taxonomy, gazetteer, interpreter, messenger, jobs, log, now };
  const engine = new ConversationEngine(services);
  const handlers = jobHandlers(services);

  return {
    config,
    db,
    services,
    engine,
    transport,
    simulator: transport instanceof SimulatorTransport ? transport : undefined,
    runJobs: () => jobs.runDue(handlers),
    close: async () => {
      await engine.idle();
      await db.close();
    },
  };
}
