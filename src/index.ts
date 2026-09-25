import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServer, registerRoutes } from "./http/server.js";

const config = loadConfig();
const server = createServer({ logger: true });
const app = await createApp(config, { log: server.log });
registerRoutes(server, app);

await app.services.jobs.recoverStuck();
// Background work: due jobs every tick, and messages a crash or restart left unhandled.
const tick = async () => {
  await app.runJobs();
  await app.engine.recover();
};
const timer = setInterval(() => {
  tick().catch((err) => server.log.error({ err: String(err) }, "Background work failed"));
}, config.jobPollSeconds * 1000);

await server.listen({ port: config.port, host: config.host });
server.log.info(
  `Interpreter: ${app.services.interpreter.name}. WhatsApp: ${config.whatsapp.transport}. Storage: ${app.store.name}.` +
    (app.simulator ? ` Simulator: http://localhost:${config.port}/simulator` : ""),
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await server.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
