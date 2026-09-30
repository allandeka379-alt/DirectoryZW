import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServer, registerRoutes } from "./http/server.js";

const config = loadConfig();
const server = createServer({ logger: true });
const app = await createApp(config, { log: server.log });
registerRoutes(server, app);

// Photos are kept where they can be written: a mounted volume may belong to another user.
try {
  const probe = `probe-${process.pid}`;
  await app.store.put(probe, Buffer.from("ok"));
  await app.store.delete(probe);
} catch (err) {
  server.log.error({ err: String(err) }, `Photo storage (${app.store.name}) can't be written: photo uploads will fail until it's fixed`);
}

await app.services.jobs.recoverStuck();
// Background work: due jobs every tick, and messages a crash or restart left unhandled. Every
// few minutes, jobs a crash left "running" go back in the queue.
let lastRecovery = Date.now();
const tick = async () => {
  await app.runJobs();
  await app.engine.recover();
  if (Date.now() - lastRecovery > 5 * 60_000) {
    lastRecovery = Date.now();
    await app.services.jobs.recoverStuck();
  }
};
const timer = setInterval(() => {
  tick().catch((err) => server.log.error({ err: String(err) }, "Background work failed"));
}, config.jobPollSeconds * 1000);
// A job due within the minute (a product alert, a catalog sync) starts then, not at the next tick.
let wake: { timer: NodeJS.Timeout; at: number } | undefined;
app.services.jobs.onSoon((runAt) => {
  const at = runAt.getTime() + 100;
  if (wake && wake.at <= at) return;
  if (wake) clearTimeout(wake.timer);
  const timer = setTimeout(() => {
    wake = undefined;
    app.runJobs().catch((err) => server.log.error({ err: String(err) }, "Background work failed"));
  }, Math.max(0, at - Date.now()));
  wake = { timer, at };
});

await server.listen({ port: config.port, host: config.host });
server.log.info(
  `Understanding: ${app.services.understanding.description}. WhatsApp: ${config.whatsapp.transport}. Storage: ${app.store.name}.` +
    (app.simulator ? ` Simulator: http://localhost:${config.port}/simulator` : ""),
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  if (wake) clearTimeout(wake.timer);
  await server.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// A promise nobody waited for is logged, not fatal. An exception nothing caught leaves the
// process in an unknown state: log it and exit, and the host starts a fresh one.
process.on("unhandledRejection", (err) => server.log.error({ err: String(err) }, "Unhandled promise rejection"));
process.on("uncaughtException", (err) => {
  server.log.error({ err: String(err), stack: err.stack }, "Uncaught exception; restarting");
  process.exit(1);
});
