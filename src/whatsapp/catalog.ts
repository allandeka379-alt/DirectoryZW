import crypto from "node:crypto";
import type { Lexicon } from "../ai/lexicon.js";
import type { Db } from "../db/client.js";
import { normalizeText } from "../text.js";
import type { Logger } from "../logger.js";

/**
 * Our Meta catalog, connected to our WhatsApp number, so replies can show WhatsApp's own product
 * cards (photos, prices, "View items"). Products with a photo and a price go in it; a product
 * changed on the dashboard is marked, and the sync sends only what changed. Meta needs a public
 * page and photo for each product: /p/:id and /media/products/:photoId.
 */

/** One product as Meta's catalog holds it (the catalog feed's fields). */
export interface CatalogItem {
  /** Our product's ID. */
  retailerId: string;
  title: string;
  description: string;
  availability: "in stock" | "out of stock";
  condition: "new";
  /** "589.00 USD". */
  price: string;
  link: string;
  imageLink: string;
  brand: string;
}

export interface BatchCheck {
  done: boolean;
  errors: { retailerId?: string; message: string }[];
}

export interface CatalogClient {
  readonly name: string;
  readonly catalogId: string;
  /** Add or change items, and take items out. Returns handles for checking the batch later. */
  batch(upserts: CatalogItem[], deletes: string[]): Promise<string[]>;
  /** What Meta found once it checked a batch. */
  check(handle: string): Promise<BatchCheck>;
}

/** The simulator's catalog: kept in memory, checked at once. */
export class MemoryCatalog implements CatalogClient {
  readonly name = "simulated";
  readonly items = new Map<string, CatalogItem>();
  private batches = 0;

  constructor(readonly catalogId: string) {}

  async batch(upserts: CatalogItem[], deletes: string[]): Promise<string[]> {
    for (const item of upserts) this.items.set(item.retailerId, item);
    for (const id of deletes) this.items.delete(id);
    return [`sim-batch-${++this.batches}`];
  }

  async check(): Promise<BatchCheck> {
    return { done: true, errors: [] };
  }
}

type Json = Record<string, any>;

/** Meta's Graph API: POST /{catalog_id}/items_batch, then check_batch_request_status by handle. */
export class GraphCatalog implements CatalogClient {
  readonly name = "meta";
  private static readonly PER_REQUEST = 1000;

  constructor(
    private readonly opts: { graphVersion: string; accessToken: string; catalogId: string; log: Logger; fetch?: typeof fetch },
  ) {}

  get catalogId(): string {
    return this.opts.catalogId;
  }

  private url(path: string): string {
    return `https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.catalogId}/${path}`;
  }

  async batch(upserts: CatalogItem[], deletes: string[]): Promise<string[]> {
    const requests = [
      ...upserts.map((i) => ({
        method: "UPDATE",
        data: {
          id: i.retailerId,
          title: i.title,
          description: i.description,
          availability: i.availability,
          condition: i.condition,
          price: i.price,
          link: i.link,
          image_link: i.imageLink,
          brand: i.brand,
        },
      })),
      ...deletes.map((id) => ({ method: "DELETE", data: { id } })),
    ];
    const handles: string[] = [];
    const doFetch = this.opts.fetch ?? fetch;
    for (let i = 0; i < requests.length; i += GraphCatalog.PER_REQUEST) {
      const res = await doFetch(this.url("items_batch"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ item_type: "PRODUCT_ITEM", allow_upsert: true, requests: requests.slice(i, i + GraphCatalog.PER_REQUEST) }),
      });
      const body = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok) throw new Error(`Catalog batch refused (${res.status}): ${body?.error?.message ?? "no details"}`);
      handles.push(...((body.handles ?? []) as string[]).map(String));
    }
    return handles;
  }

  async check(handle: string): Promise<BatchCheck> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.url("check_batch_request_status")}?handle=${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${this.opts.accessToken}` },
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`Catalog batch check refused (${res.status}): ${body?.error?.message ?? "no details"}`);
    const status = (body.data?.[0] ?? body) as Json;
    const errors = ((status.errors ?? []) as Json[]).map((e) => ({
      retailerId: e.id != null ? String(e.id) : e.retailer_id != null ? String(e.retailer_id) : undefined,
      message: String(e.message ?? e.error_message ?? "rejected"),
    }));
    return { done: status.status === "finished" || status.status === "complete" || status.status === "completed", errors };
  }
}

// ---------- What goes in ----------

interface ProductRow {
  id: string;
  business_id: string;
  name: string;
  description: string;
  price_usd: string | null;
  in_stock: boolean;
  archived_at: Date | null;
  photo_id: string | null;
  b_name: string;
  status: string;
  trade: string;
  verification: string;
  area: string | null;
  blocked: boolean;
}

/**
 * Why a product isn't in the catalog, or null when it is: it needs a live business, stock, a photo
 * and a price. Out of stock comes out, so WhatsApp never shows a card for something nobody can buy.
 */
export function catalogGap(r: Pick<ProductRow, "archived_at" | "in_stock" | "status" | "trade" | "blocked" | "price_usd" | "photo_id">): string | null {
  if (r.archived_at) return "taken down";
  if (!r.in_stock) return "out of stock";
  if (r.status !== "active") return "the business isn't live";
  if (r.trade === "wholesale") return "wholesale only";
  if (r.blocked) return "not allowed";
  if (r.price_usd == null) return "no price";
  if (!r.photo_id) return "no photo";
  return null;
}

/** The brand in a product's name, when it names one we know ("Samsung"); otherwise the store. */
function brandOf(name: string, store: string, lexicon?: Lexicon): string {
  for (const w of normalizeText(name).split(" ")) {
    if (lexicon?.word(w)?.some((s) => s.role === "brand")) return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return store;
}

export function catalogItem(r: ProductRow, publicBaseUrl: string, lexicon?: Lexicon): CatalogItem {
  const where = r.area ? ` in ${r.area}` : "";
  const checked = r.verification === "verified" ? ", verified by our team" : "";
  const said = r.description.trim().replace(/\s+/g, " ");
  const about = said ? `${said}${/[.!?]$/.test(said) ? "" : "."} ` : "";
  return {
    retailerId: r.id,
    title: r.name.slice(0, 150),
    description: `${about}Sold by ${r.b_name}${where}${checked}.`.slice(0, 5000),
    availability: r.in_stock ? "in stock" : "out of stock",
    condition: "new",
    price: `${Number(r.price_usd).toFixed(2)} USD`,
    link: `${publicBaseUrl}/p/${r.id}`,
    imageLink: `${publicBaseUrl}/media/products/${r.photo_id}`,
    brand: brandOf(r.name, r.b_name, lexicon).slice(0, 100),
  };
}

const hashOf = (item: CatalogItem) => crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex");

export interface SyncResult {
  upserted: number;
  deleted: number;
  /** More changes are waiting than one run takes. */
  more: boolean;
}

/**
 * Send the catalog what changed: marked products are unmarked first, then read, so a product edited
 * during the sync is marked again and goes next time. If Meta refuses the batch, they're marked again.
 */
export async function syncCatalog(
  db: Db,
  client: CatalogClient,
  opts: { publicBaseUrl: string; lexicon?: Lexicon; log: Logger; batchSize?: number },
): Promise<SyncResult> {
  const size = opts.batchSize ?? 2000;
  await checkBatches(db, client, opts.log);

  const ids = (
    await db.query<{ id: string }>("UPDATE offerings SET catalog_dirty = false WHERE id IN (SELECT id FROM offerings WHERE catalog_dirty LIMIT $1) RETURNING id", [size])
  ).map((r) => r.id);
  const rows = ids.length
    ? await db.query<ProductRow & { synced_hash: string | null }>(
        `SELECT o.id, o.business_id, o.name, o.description, o.price_usd, o.in_stock, o.archived_at, o.photo_id,
                b.name AS b_name, b.status, b.trade, b.verification, a.name AS area,
                EXISTS (SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
                         WHERE bc.business_id = b.id AND c.risk IN ('blocked', 'restricted')) AS blocked,
                ci.hash AS synced_hash
           FROM offerings o
           JOIN businesses b ON b.id = o.business_id
           LEFT JOIN areas a ON a.id = b.area_id
           LEFT JOIN catalog_items ci ON ci.retailer_id = o.id::text
          WHERE o.id = ANY($1::uuid[])`,
        [ids],
      )
    : [];

  const upserts: { item: CatalogItem; hash: string; businessId: string }[] = [];
  const deletes: string[] = [];
  for (const r of rows) {
    if (catalogGap(r)) {
      if (r.synced_hash) deletes.push(r.id);
      continue;
    }
    const item = catalogItem(r, opts.publicBaseUrl, opts.lexicon);
    const hash = hashOf(item);
    if (hash !== r.synced_hash) upserts.push({ item, hash, businessId: r.business_id });
  }
  // Products deleted with their business: still in the catalog, so taken out.
  const orphans = await db.query<{ retailer_id: string }>(
    "SELECT ci.retailer_id FROM catalog_items ci LEFT JOIN offerings o ON o.id = ci.offering_id WHERE o.id IS NULL LIMIT $1",
    [size],
  );
  deletes.push(...orphans.map((o) => o.retailer_id));

  if (upserts.length || deletes.length) {
    let handles: string[];
    try {
      handles = await client.batch(
        upserts.map((u) => u.item),
        deletes,
      );
    } catch (err) {
      await db.query("UPDATE offerings SET catalog_dirty = true WHERE id = ANY($1::uuid[])", [ids]);
      throw err;
    }
    for (const u of upserts) {
      await db.query(
        `INSERT INTO catalog_items (retailer_id, offering_id, business_id, hash, synced_at, error) VALUES ($1, $2, $3, $4, now(), NULL)
         ON CONFLICT (retailer_id) DO UPDATE SET hash = EXCLUDED.hash, business_id = EXCLUDED.business_id, synced_at = now(), error = NULL`,
        [u.item.retailerId, u.item.retailerId, u.businessId, u.hash],
      );
    }
    if (deletes.length) await db.query("DELETE FROM catalog_items WHERE retailer_id = ANY($1::text[])", [deletes]);
    for (const handle of handles) {
      await db.query("INSERT INTO catalog_batches (handle, items) VALUES ($1, $2) ON CONFLICT (handle) DO NOTHING", [handle, upserts.length + deletes.length]);
    }
    opts.log.info({ upserted: upserts.length, deleted: deletes.length, catalog: client.catalogId }, "Catalog synced");
  }
  const more = ids.length === size || orphans.length === size;
  return { upserted: upserts.length, deleted: deletes.length, more };
}

/** Meta checks a batch after accepting it: record what it refused, on the items. */
async function checkBatches(db: Db, client: CatalogClient, log: Logger): Promise<void> {
  const pending = await db.query<{ handle: string }>(
    "SELECT handle FROM catalog_batches WHERE status = 'pending' ORDER BY created_at LIMIT 20",
  );
  for (const { handle } of pending) {
    try {
      const result = await client.check(handle);
      if (!result.done) continue;
      await db.query("UPDATE catalog_batches SET status = $2, errors = $3, checked_at = now() WHERE handle = $1", [
        handle,
        result.errors.length ? "errors" : "done",
        JSON.stringify(result.errors.slice(0, 200)),
      ]);
      for (const e of result.errors) {
        if (e.retailerId) await db.query("UPDATE catalog_items SET error = $2 WHERE retailer_id = $1", [e.retailerId, e.message.slice(0, 500)]);
      }
    } catch (err) {
      log.warn({ handle, err: String(err) }, "Couldn't check a catalog batch; trying again next time");
    }
  }
}

/** For the admin portal: how the catalog stands. */
export async function catalogStatus(db: Db) {
  const row = await db.query<{ live: number; waiting: number; errors: number; last_synced: Date | null; pending_batches: number }>(
    `SELECT (SELECT count(*)::int FROM catalog_items) AS live,
            (SELECT count(*)::int FROM offerings WHERE catalog_dirty AND archived_at IS NULL) AS waiting,
            (SELECT count(*)::int FROM catalog_items WHERE error IS NOT NULL) AS errors,
            (SELECT max(synced_at) FROM catalog_items) AS last_synced,
            (SELECT count(*)::int FROM catalog_batches WHERE status = 'pending') AS pending_batches`,
  );
  const problems = await db.query<{ retailer_id: string; name: string | null; business: string | null; error: string }>(
    `SELECT ci.retailer_id, o.name, b.name AS business, ci.error
       FROM catalog_items ci LEFT JOIN offerings o ON o.id = ci.offering_id LEFT JOIN businesses b ON b.id = ci.business_id
      WHERE ci.error IS NOT NULL ORDER BY ci.synced_at DESC LIMIT 20`,
  );
  return { ...row[0]!, problems };
}

/** Send everything again (a new catalog, or after fixing a setting): every product is marked. */
export async function markAllForCatalog(db: Db): Promise<number> {
  const rows = await db.query("UPDATE offerings SET catalog_dirty = true WHERE NOT catalog_dirty RETURNING id");
  return rows.length;
}
