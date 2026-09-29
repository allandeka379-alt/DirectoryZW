import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import sharp from "sharp";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { FileStore } from "../storage.js";
import { attachLinkedPhoto } from "./catalog.js";

/**
 * Photos from the links in a product upload ("Photo link" column): big stores keep their product
 * photos on their website. The server fetches each link itself, only from the public internet, and
 * shrinks the photo to the size of one added by hand. Links wait in photo_fetches, one per product,
 * and are fetched a few at a time in the background.
 */

// Photos are shrunk one at a time and not cached: the server has other work to do.
sharp.cache(false);
sharp.concurrency(1);

// ---------- Fetching a link ----------

/** Why a link gave us no photo, in words for the owner. `retry`: it may work later. */
export class PhotoLinkError extends Error {
  constructor(
    message: string,
    readonly retry = false,
  ) {
    super(message);
  }
}

export interface FetchedPhoto {
  data: Buffer;
  contentType: string;
}

export type PhotoFetcher = (url: string) => Promise<FetchedPhoto>;

const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "FindZim-photo-links/1.0";
const TOO_BIG = "The photo is bigger than 15 MB";

// Addresses a link may never reach: this machine, our own network, cloud metadata, reserved ranges.
// Two lists: Node checks an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d), and the IPv6
// list blocks every IPv4-mapped address.
const PRIVATE_V4 = new net.BlockList();
const PRIVATE_V6 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE_V4.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, Teredo among them
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  PRIVATE_V6.addSubnet(address, prefix, "ipv6");
}

/** On the public internet: never this machine, our own network or cloud metadata. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = net.isIP(ip);
  if (family === 4) return !PRIVATE_V4.check(ip, "ipv4");
  if (family === 6) return !PRIVATE_V6.check(ip, "ipv6");
  return false;
}

/**
 * A link we'll open: http or https on the usual ports, with no password in it, and not an address on
 * a private network. `anywhere` is for tests, which serve photos from this machine.
 */
function linkUrl(link: string, anywhere: boolean): URL {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new PhotoLinkError("The photo link isn't a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PhotoLinkError("The photo link must start with https://");
  if (url.username || url.password) throw new PhotoLinkError("The photo link has a password in it");
  if (!anywhere && url.port && url.port !== "80" && url.port !== "443") throw new PhotoLinkError("The photo link uses an unusual port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!anywhere && net.isIP(host) && !isPublicAddress(host)) throw new PhotoLinkError("The photo link points to a private address");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * DNS that answers only with public addresses, so a link can't reach our own network by a name
 * either. The connection goes to the address checked here, not to a second lookup.
 */
function publicLookup(anywhere: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, []);
      if (!addresses.length || (!anywhere && addresses.some((a) => !isPublicAddress(a.address)))) {
        return callback(Object.assign(new Error(`${hostname} is on a private network`), { code: "EPRIVATE" }), []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function statusProblem(status: number): string {
  if (status === 404 || status === 410) return `The link gives "not found" (${status})`;
  if (status === 401 || status === 403) return `The website won't share the photo (${status})`;
  if (status === 429) return "The website asked us to slow down (429)";
  if (status >= 500) return `The website had a problem (${status})`;
  return `The link didn't give a photo (${status})`;
}

function networkProblem(err: NodeJS.ErrnoException): PhotoLinkError {
  if (err instanceof PhotoLinkError) return err;
  switch (err.code) {
    case "EPRIVATE":
      return new PhotoLinkError("The photo link points to a private address");
    case "ENOTFOUND":
      return new PhotoLinkError("The website in the link doesn't exist");
    case "EAI_AGAIN":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new PhotoLinkError("The website didn't answer", true);
    default:
      if (/CERT|SSL|TLS/i.test(err.code ?? "") || /certificate/i.test(err.message)) {
        return new PhotoLinkError("The website's security certificate isn't valid");
      }
      return new PhotoLinkError("The link couldn't be opened", true);
  }
}

interface Answer {
  location?: string;
  contentType: string;
  data?: Buffer;
}

/** One request: a redirect's target, or the photo's bytes, never more than `maxBytes`. */
function getOnce(url: URL, anywhere: boolean, maxBytes: number, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { lookup: publicLookup(anywhere), headers: { "User-Agent": USER_AGENT, Accept: "image/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(() => resolve({ location: res.headers.location, contentType: "" }));
      }
      if (status !== 200) {
        res.resume();
        return finish(() => reject(new PhotoLinkError(statusProblem(status), status === 429 || status >= 500)));
      }
      if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
        res.destroy();
        return finish(() => reject(new PhotoLinkError(TOO_BIG)));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish(() => reject(new PhotoLinkError(TOO_BIG)));
        } else {
          chunks.push(chunk);
        }
      });
      res.on("end", () => finish(() => resolve({ contentType: String(res.headers["content-type"] ?? ""), data: Buffer.concat(chunks) })));
      res.on("error", () => finish(() => reject(new PhotoLinkError("The download was cut off", true))));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new PhotoLinkError("The website took too long to answer", true)));
    }, timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) => finish(() => reject(networkProblem(err))));
  });
}

/** A photo from a link on the public internet: redirects followed and checked, at most 15 MB and 20 seconds a step. */
export async function fetchPhotoLink(
  link: string,
  opts: { anywhere?: boolean; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchedPhoto> {
  const anywhere = opts.anywhere ?? false;
  let url = linkUrl(link, anywhere);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const answer = await getOnce(url, anywhere, opts.maxBytes ?? MAX_DOWNLOAD_BYTES, opts.timeoutMs ?? TIMEOUT_MS);
    if (answer.data) return { data: answer.data, contentType: answer.contentType };
    if (!answer.location) throw new PhotoLinkError("The link sends us elsewhere, but doesn't say where");
    url = linkUrl(new URL(answer.location, url).toString(), anywhere);
  }
  throw new PhotoLinkError("The link sends us elsewhere too many times");
}

// ---------- Making it a photo like the others ----------

/** The longest side of a photo we keep, as for one added on the dashboard. */
export const PHOTO_EDGE = 1280;
const READABLE = new Set(["jpeg", "png", "webp", "gif", "avif", "heif", "tiff"]);
const LIMIT_PIXELS = 60_000_000;

/** Any common photo format as a JPEG the size of a photo added by hand. Anything else doesn't get through. */
export async function shrinkLinkedPhoto(input: Buffer): Promise<Buffer> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: LIMIT_PIXELS }).metadata()).format;
  } catch {
    throw new PhotoLinkError("The link isn't a photo");
  }
  if (!format || !READABLE.has(format)) throw new PhotoLinkError("The link isn't a photo we can use (JPEG, PNG and WebP work)");
  try {
    for (const quality of [82, 68]) {
      const out = await sharp(input, { limitInputPixels: LIMIT_PIXELS })
        .rotate()
        .resize({ width: PHOTO_EDGE, height: PHOTO_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= 1.8 * 1024 * 1024) return out;
    }
  } catch {
    throw new PhotoLinkError("The photo couldn't be read");
  }
  throw new PhotoLinkError("The photo is too big, even made smaller");
}

// ---------- The queue ----------

export interface PhotoLinkDeps {
  db: Db;
  store: FileStore;
  log: Logger;
  now: () => Date;
  fetch: PhotoFetcher;
}

export interface FetchRound {
  done: number;
  failed: number;
  /** Businesses whose products got a new photo. */
  businesses: string[];
  /** When the next link is due, if any are waiting. */
  next: Date | null;
}

const ATTEMPTS = 3;

/** Run `fn` over `items`, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Fetch the next links: at most three per business in a round, so one store's 17,000 photos never
 * hold up another's ten. A link that may work later is tried again after 5, then 10 minutes.
 */
export async function fetchQueuedPhotos(deps: PhotoLinkDeps, opts: { batch?: number; concurrency?: number } = {}): Promise<FetchRound> {
  const { db } = deps;
  const now = deps.now();
  // Links left half done by a restart go back in the queue.
  await db.query("UPDATE photo_fetches SET status = 'queued' WHERE status = 'fetching' AND updated_at < $1", [new Date(now.getTime() - 10 * 60_000)]);
  const picked = await db.query<{ offering_id: string; business_id: string; url: string; attempts: number }>(
    `UPDATE photo_fetches SET status = 'fetching', updated_at = $1
      WHERE offering_id IN (
        SELECT offering_id FROM (
          SELECT offering_id, next_try_at, row_number() OVER (PARTITION BY business_id ORDER BY next_try_at, created_at) AS n
            FROM photo_fetches WHERE status = 'queued' AND next_try_at <= $1
        ) waiting WHERE n <= 3 ORDER BY next_try_at LIMIT $2)
      RETURNING offering_id, business_id, url, attempts`,
    [now, opts.batch ?? 12],
  );

  // The same link on several products (sizes of one paint) is downloaded once in a round.
  const photos = new Map<string, Promise<Buffer>>();
  const photoFor = (url: string) => {
    let p = photos.get(url);
    if (!p) {
      p = deps.fetch(url).then((f) => shrinkLinkedPhoto(f.data));
      photos.set(url, p);
    }
    return p;
  };

  let done = 0;
  let failed = 0;
  const businesses = new Set<string>();
  await eachLimited(picked, opts.concurrency ?? 6, async (f) => {
    try {
      const data = await photoFor(f.url);
      if (await attachLinkedPhoto(db, deps.store, f.business_id, f.offering_id, f.url, data, deps.now())) {
        done++;
        businesses.add(f.business_id);
      }
      await db.query("UPDATE photo_fetches SET status = 'done', error = NULL, attempts = attempts + 1, updated_at = $3 WHERE offering_id = $1 AND url = $2", [
        f.offering_id,
        f.url,
        deps.now(),
      ]);
    } catch (err) {
      const problem = err instanceof PhotoLinkError ? err : new PhotoLinkError("The photo couldn't be saved", true);
      if (!(err instanceof PhotoLinkError)) deps.log.warn({ err: String(err), url: f.url }, "A photo link failed unexpectedly");
      const attempts = f.attempts + 1;
      const again = problem.retry && attempts < ATTEMPTS;
      if (!again) failed++;
      await db.query(
        `UPDATE photo_fetches SET status = $3, error = $4, attempts = $5, next_try_at = $6, updated_at = $7
          WHERE offering_id = $1 AND url = $2`,
        [f.offering_id, f.url, again ? "queued" : "failed", problem.message, attempts, new Date(deps.now().getTime() + attempts * 5 * 60_000), deps.now()],
      );
    }
  });

  const next = await one<{ at: Date | null }>(db, "SELECT min(next_try_at) AS at FROM photo_fetches WHERE status = 'queued'");
  return { done, failed, businesses: [...businesses], next: next?.at ? new Date(next.at) : null };
}

// ---------- For the dashboard ----------

export interface PhotoLinkStatus {
  /** Links waiting or being fetched now. */
  waiting: number;
  failed: number;
  failures: { productId: string; name: string; url: string; error: string }[];
}

export async function photoLinkStatus(db: Db, businessId: string): Promise<PhotoLinkStatus> {
  const counts = await one<{ waiting: number; failed: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status IN ('queued', 'fetching'))::int AS waiting,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM photo_fetches WHERE business_id = $1`,
    [businessId],
  );
  const failures = await db.query<{ offering_id: string; name: string; url: string; error: string | null }>(
    `SELECT f.offering_id, o.name, f.url, f.error FROM photo_fetches f JOIN offerings o ON o.id = f.offering_id
      WHERE f.business_id = $1 AND f.status = 'failed' ORDER BY lower(o.name) LIMIT 200`,
    [businessId],
  );
  return {
    waiting: counts?.waiting ?? 0,
    failed: counts?.failed ?? 0,
    failures: failures.map((f) => ({ productId: f.offering_id, name: f.name, url: f.url, error: f.error ?? "It didn't work" })),
  };
}

/** Try the links that failed again: the website may be back, or the owner fixed it. */
export async function retryPhotoLinks(db: Db, businessId: string, now: Date): Promise<number> {
  const rows = await db.query(
    `UPDATE photo_fetches SET status = 'queued', attempts = 0, error = NULL, next_try_at = $2, updated_at = $2
      WHERE business_id = $1 AND status = 'failed' RETURNING offering_id`,
    [businessId, now],
  );
  return rows.length;
}

/** Forget the links that failed: the owner will add those photos another way. */
export async function clearFailedPhotoLinks(db: Db, businessId: string): Promise<number> {
  const rows = await db.query("DELETE FROM photo_fetches WHERE business_id = $1 AND status = 'failed' RETURNING offering_id", [businessId]);
  return rows.length;
}
