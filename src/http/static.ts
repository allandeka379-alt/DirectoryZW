import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Front-end files live in /public at the project root (two levels up from src/http and dist/http). */
export const PUBLIC_DIR = new URL("../../public/", import.meta.url);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

/**
 * Send a file with an ETag, or "304 Not Modified" when the browser already has this version.
 * Files stay "no-cache" (always checked, so edits show at once), but a check costs a few hundred
 * bytes instead of the whole file: on expensive mobile data that matters.
 */
function sendWithEtag(req: FastifyRequest, reply: FastifyReply, data: Buffer, type: string, headers: Record<string, string>) {
  const etag = `"${createHash("sha1").update(data).digest("base64url").slice(0, 16)}"`;
  reply.type(type).headers({ ...headers, ETag: etag });
  const asked = req.headers["if-none-match"];
  if (asked && asked.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return reply.code(304).send();
  return reply.send(data);
}

/** A file name the website's asset folder may hold: lower-case words, one known extension. */
const ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.(svg|webp|avif|png|jpg|js|css|woff2)$/;

/**
 * The public website's own images, script and fonts, from public/site/assets: any file there with
 * a plain name. No folders, no other extensions, so nothing else in /public can be reached.
 */
export function serveAssetFolder(server: FastifyInstance, route: string, folder: string): void {
  server.get(`${route}/:name`, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!ASSET_NAME.test(name)) return reply.code(404).send({ error: "Not found" });
    try {
      const data = await fs.readFile(new URL(`${folder}/${name}`, PUBLIC_DIR));
      // "no-cache" like the pages: the names are not versioned, so a cached sprite or script could
      // go stale against new HTML after a deploy. The ETag keeps each check to a 304.
      return sendWithEtag(req, reply, data, TYPES[path.extname(name)] ?? "application/octet-stream", { "Cache-Control": "no-cache" });
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });
}

/** Serve one known file from /public at a fixed route (no directory listing, no path input). */
export function serveFile(server: FastifyInstance, route: string, file: string, headers: Record<string, string> = {}): void {
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  server.get(route, async (req, reply) => {
    const data = await fs.readFile(new URL(file, PUBLIC_DIR));
    return sendWithEtag(req, reply, data, type, { "Cache-Control": "no-cache", ...headers });
  });
}
