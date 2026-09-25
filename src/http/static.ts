import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/** Front-end files live in /public at the project root (two levels up from src/http and dist/http). */
const PUBLIC_DIR = new URL("../../public/", import.meta.url);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

/** Serve one known file from /public at a fixed route (no directory listing, no path input). */
export function serveFile(server: FastifyInstance, route: string, file: string, headers: Record<string, string> = {}): void {
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  server.get(route, async (_req, reply) => {
    const data = await fs.readFile(new URL(file, PUBLIC_DIR));
    return reply.type(type).headers({ "Cache-Control": "no-cache", ...headers }).send(data);
  });
}
