import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import type { FileStore } from "../storage.js";

/** Most products one business can list (the largest chains carry about 17,000). */
export const MAX_PRODUCTS = 25_000;
/** Rows accepted in one bulk-upload request; the dashboard sends bigger files in batches. */
export const MAX_IMPORT_ROWS = 2_000;
/** Shopfront and inside photos a business can show. */
export const MAX_BUSINESS_PHOTOS = 8;
/** Prices older than this are flagged on the dashboard so owners confirm them. */
export const STALE_PRICE_DAYS = 30;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const money = z.number().min(0).max(1_000_000).transform((v) => Math.round(v * 100) / 100);
const text = (max: number) => z.string().trim().max(max);
const uuid = z.string().refine(isUuid, "Not a valid ID");

/** A new product. Price is US dollars, or null for "ask us". */
export const ProductInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: text(500).default(""),
  price: money.nullable().default(null),
  unit: text(30).nullish(),
  sku: text(60).nullish(),
  category: text(60).nullish(),
  inStock: z.boolean().default(true),
});
export type ProductInput = z.infer<typeof ProductInput>;

/** A change to a product: missing fields stay as they are; null clears unit, code, category or price. */
export const ProductPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: text(500).optional(),
  price: money.nullable().optional(),
  unit: text(30).nullish(),
  sku: text(60).nullish(),
  category: text(60).nullish(),
  inStock: z.boolean().optional(),
});
export type ProductPatch = z.infer<typeof ProductPatch>;

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number | null;
  /** How the price was written on an old price list, when it wasn't a plain US dollar amount. */
  priceText: string | null;
  unit: string | null;
  sku: string | null;
  category: string | null;
  inStock: boolean;
  photoId: string | null;
  source: string;
  priceUpdatedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  description: string;
  price_usd: string | null;
  price_text: string | null;
  unit: string | null;
  sku: string | null;
  category: string | null;
  in_stock: boolean;
  photo_id: string | null;
  source: string;
  price_updated_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

const COLUMNS = "id, name, description, price_usd, price_text, unit, sku, category, in_stock, photo_id, source, price_updated_at, updated_at, created_at";
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const blank = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v.trim());
const dollars = (v: string | null) => (v == null ? null : Number(v));

function toProduct(r: Row): Product {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    price: dollars(r.price_usd),
    priceText: r.price_usd == null ? r.price_text : null,
    unit: r.unit,
    sku: r.sku,
    category: r.category,
    inStock: r.in_stock,
    photoId: r.photo_id,
    source: r.source,
    priceUpdatedAt: iso(r.price_updated_at),
    updatedAt: iso(r.updated_at)!,
    createdAt: iso(r.created_at)!,
  };
}

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - STALE_PRICE_DAYS * 24 * 3600_000);
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------- Reading ----------

export const ProductQuery = z.object({
  q: z.string().max(100).optional(),
  stock: z.enum(["in", "out"]).optional(),
  /** "photo": without a photo; "price": no price, or a price older than STALE_PRICE_DAYS */
  needs: z.enum(["photo", "price"]).optional(),
  category: z.string().max(60).optional(),
  sort: z.enum(["name", "price", "updated"]).default("name"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listProducts(db: Db, businessId: string, q: z.infer<typeof ProductQuery>, now: Date) {
  const where = ["business_id = $1", "archived_at IS NULL"];
  const params: unknown[] = [businessId];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (q.q?.trim()) {
    const p = param(`%${q.q.trim()}%`);
    where.push(`(name ILIKE ${p} OR coalesce(sku, '') ILIKE ${p} OR coalesce(category, '') ILIKE ${p})`);
  }
  if (q.stock) where.push(`in_stock = ${param(q.stock === "in")}`);
  if (q.needs === "photo") where.push("photo_id IS NULL");
  if (q.needs === "price") where.push(`(price_usd IS NULL OR price_updated_at IS NULL OR price_updated_at < ${param(staleBefore(now))})`);
  if (q.category) where.push(`category = ${param(q.category)}`);
  const order = { name: "lower(name)", price: "price_usd NULLS LAST, lower(name)", updated: "updated_at DESC, lower(name)" }[q.sort];
  const filter = where.join(" AND ");
  const [rows, total] = await Promise.all([
    db.query<Row>(`SELECT ${COLUMNS} FROM offerings WHERE ${filter} ORDER BY ${order} LIMIT ${q.limit} OFFSET ${q.offset}`, params),
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM offerings WHERE ${filter}`, params),
  ]);
  return { items: rows.map(toProduct), total: total?.n ?? 0 };
}

/** How complete the catalogue is, for the dashboard. */
export async function catalogHealth(db: Db, businessId: string, now: Date) {
  const row = await one<{ total: number; no_price: number; stale: number; out_of_stock: number; no_photo: number }>(
    db,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE price_usd IS NULL)::int AS no_price,
            count(*) FILTER (WHERE price_usd IS NOT NULL AND (price_updated_at IS NULL OR price_updated_at < $2))::int AS stale,
            count(*) FILTER (WHERE NOT in_stock)::int AS out_of_stock,
            count(*) FILTER (WHERE photo_id IS NULL)::int AS no_photo
       FROM offerings WHERE business_id = $1 AND archived_at IS NULL`,
    [businessId, staleBefore(now)],
  );
  const categories = await db.query<{ category: string; n: number }>(
    `SELECT category, count(*)::int AS n FROM offerings
      WHERE business_id = $1 AND archived_at IS NULL AND category IS NOT NULL
      GROUP BY category ORDER BY lower(category)`,
    [businessId],
  );
  return { total: row!.total, noPrice: row!.no_price, stale: row!.stale, outOfStock: row!.out_of_stock, noPhoto: row!.no_photo, categories };
}

export async function getProduct(db: Db, businessId: string, id: string): Promise<Product | undefined> {
  if (!isUuid(id)) return undefined;
  const row = await one<Row>(db, `SELECT ${COLUMNS} FROM offerings WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`, [id, businessId]);
  return row ? toProduct(row) : undefined;
}

export async function priceHistory(db: Db, businessId: string, id: string) {
  const rows = await db.query<{ old_price: string | null; new_price: string | null; reason: string; created_at: Date }>(
    `SELECT old_price, new_price, reason, created_at FROM offering_price_changes
      WHERE offering_id = $1 AND business_id = $2 ORDER BY created_at DESC LIMIT 20`,
    [id, businessId],
  );
  return rows.map((r) => ({ oldPrice: dollars(r.old_price), newPrice: dollars(r.new_price), reason: r.reason, at: iso(r.created_at) }));
}

// ---------- Adding and changing one product ----------

async function liveCount(db: Db, businessId: string): Promise<number> {
  return (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM offerings WHERE business_id = $1 AND archived_at IS NULL", [businessId]))!.n;
}

/** Codes are unique within a business, whatever their case. Throws naming the product that has the code. */
async function checkSkuFree(db: Db, businessId: string, sku: string | null, exceptId: string | null): Promise<void> {
  if (!sku) return;
  const taken = await one<{ name: string; sku: string }>(
    db,
    `SELECT name, sku FROM offerings
      WHERE business_id = $1 AND lower(sku) = lower($2) AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [businessId, sku, exceptId],
  );
  if (taken) throw new CatalogError(`${taken.name} already uses the code ${taken.sku}.`, 409);
}

async function recordPriceChange(db: Db, businessId: string, offeringId: string, oldPrice: number | null, newPrice: number | null, reason: "edit" | "bulk" | "import"): Promise<void> {
  await db.query("INSERT INTO offering_price_changes (offering_id, business_id, old_price, new_price, reason) VALUES ($1, $2, $3, $4, $5)", [
    offeringId,
    businessId,
    oldPrice,
    newPrice,
    reason,
  ]);
}

async function insertProduct(db: Db, businessId: string, p: ProductInput, now: Date, source: "dashboard" | "import"): Promise<Row> {
  const row = await one<Row>(
    db,
    `INSERT INTO offerings (business_id, name, description, price_usd, unit, sku, category, in_stock, source, price_updated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${COLUMNS}`,
    [businessId, p.name, p.description, p.price, blank(p.unit), blank(p.sku), blank(p.category), p.inStock, source, now],
  );
  if (p.price != null) await recordPriceChange(db, businessId, row!.id, null, p.price, source === "import" ? "import" : "edit");
  return row!;
}

export async function createProduct(db: Db, businessId: string, input: ProductInput, now: Date): Promise<Product> {
  if ((await liveCount(db, businessId)) >= MAX_PRODUCTS) throw new CatalogError(`A business can list up to ${MAX_PRODUCTS.toLocaleString("en")} products.`);
  await checkSkuFree(db, businessId, blank(input.sku), null);
  const row = await insertProduct(db, businessId, input, now, "dashboard");
  return toProduct(row);
}

/** Apply a patch. Only the fields it names change; a new price is dated and kept in the history. */
async function applyPatch(db: Db, businessId: string, id: string, patch: ProductPatch, now: Date, reason: "edit" | "import"): Promise<boolean> {
  const current = await one<{ price_usd: string | null }>(db, "SELECT price_usd FROM offerings WHERE id = $1 AND business_id = $2 AND archived_at IS NULL", [id, businessId]);
  if (!current) return false;
  const params: unknown[] = [id, businessId];
  const sets: string[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.unit !== undefined) set("unit", blank(patch.unit));
  if (patch.sku !== undefined) set("sku", blank(patch.sku));
  if (patch.category !== undefined) set("category", blank(patch.category));
  if (patch.inStock !== undefined) set("in_stock", patch.inStock);
  const oldPrice = dollars(current.price_usd);
  const priceChanged = patch.price !== undefined && patch.price !== oldPrice;
  if (priceChanged) {
    set("price_usd", patch.price);
    sets.push("price_text = NULL");
    set("price_updated_at", now);
  }
  set("updated_at", now);
  sets.push("catalog_dirty = true");
  await db.query(`UPDATE offerings SET ${sets.join(", ")} WHERE id = $1 AND business_id = $2`, params);
  if (priceChanged) await recordPriceChange(db, businessId, id, oldPrice, patch.price ?? null, reason);
  return true;
}

export async function updateProduct(db: Db, businessId: string, id: string, patch: ProductPatch, now: Date): Promise<Product> {
  if (!isUuid(id)) throw new CatalogError("Product not found", 404);
  if (patch.sku !== undefined) await checkSkuFree(db, businessId, blank(patch.sku), id);
  if (!(await applyPatch(db, businessId, id, patch, now, "edit"))) throw new CatalogError("Product not found", 404);
  return (await getProduct(db, businessId, id))!;
}

export async function archiveProducts(db: Db, store: FileStore, businessId: string, ids: string[], now: Date): Promise<number> {
  const rows = await db.query<{ id: string; photo_id: string | null }>(
    `UPDATE offerings SET archived_at = $3, updated_at = $3, catalog_dirty = true
      WHERE business_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL RETURNING id, photo_id`,
    [businessId, ids.filter(isUuid), now],
  );
  if (rows.length) await db.query("DELETE FROM photo_fetches WHERE offering_id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
  for (const r of rows) {
    if (!r.photo_id) continue;
    await db.query("UPDATE offerings SET photo_id = NULL, photo_source_url = NULL WHERE id = $1", [r.id]);
    await deletePhoto(db, store, businessId, r.photo_id);
  }
  return rows.length;
}

export async function setStock(db: Db, businessId: string, ids: string[], inStock: boolean, now: Date): Promise<number> {
  const rows = await db.query(
    `UPDATE offerings SET in_stock = $3, updated_at = $4, catalog_dirty = true
      WHERE business_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL RETURNING id`,
    [businessId, ids.filter(isUuid), inStock, now],
  );
  return rows.length;
}

/** The owner says these prices are still right: customers see today's date on them. */
export async function confirmPrices(db: Db, businessId: string, ids: string[] | "all", now: Date): Promise<number> {
  const rows = await db.query(
    `UPDATE offerings SET price_updated_at = $3, updated_at = $3, catalog_dirty = true
      WHERE business_id = $1 AND archived_at IS NULL AND price_usd IS NOT NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      RETURNING id`,
    [businessId, ids === "all" ? null : ids.filter(isUuid), now],
  );
  return rows.length;
}

// ---------- Changing many prices at once ----------

export const PriceAdjustment = z.object({
  scope: z.union([
    z.object({ ids: z.array(uuid).min(1).max(MAX_PRODUCTS) }),
    z.object({ category: z.string().min(1).max(60) }),
    z.object({ all: z.literal(true) }),
  ]),
  /** percent: +10 or -5; amount: +0.50 or -1; set: the new price */
  mode: z.enum(["percent", "amount", "set"]),
  value: z.number().min(-1_000_000).max(1_000_000),
  round: z.enum(["cents", "0.05", "0.10", "0.50", "1"]).default("cents"),
  dryRun: z.boolean().default(false),
});

export function adjustedPrice(price: number | null, mode: "percent" | "amount" | "set", value: number, round: string): number | null {
  let next: number;
  if (mode === "set") next = value;
  else if (price == null) return null; // nothing to raise or cut
  else next = mode === "percent" ? price * (1 + value / 100) : price + value;
  const step = round === "cents" ? 0.01 : Number(round);
  const rounded = Math.round(Math.max(0, next) / step) * step;
  return Math.round(rounded * 100) / 100;
}

export async function adjustPrices(db: Db, businessId: string, input: z.infer<typeof PriceAdjustment>, now: Date) {
  const where = ["business_id = $1", "archived_at IS NULL"];
  const params: unknown[] = [businessId];
  if ("ids" in input.scope) {
    params.push(input.scope.ids);
    where.push(`id = ANY($${params.length}::uuid[])`);
  } else if ("category" in input.scope) {
    params.push(input.scope.category);
    where.push(`category = $${params.length}`);
  }
  const rows = await db.query<{ id: string; name: string; price_usd: string | null }>(
    `SELECT id, name, price_usd FROM offerings WHERE ${where.join(" AND ")} ORDER BY lower(name)`,
    params,
  );
  const changes: { id: string; name: string; oldPrice: number | null; newPrice: number }[] = [];
  for (const r of rows) {
    const old = dollars(r.price_usd);
    const next = adjustedPrice(old, input.mode, input.value, input.round);
    if (next != null && next !== old) changes.push({ id: r.id, name: r.name, oldPrice: old, newPrice: next });
  }
  if (!input.dryRun && changes.length) {
    await db.transaction(async (tx) => {
      for (const c of changes) {
        await tx.query(
          "UPDATE offerings SET price_usd = $3, price_text = NULL, price_updated_at = $4, updated_at = $4, catalog_dirty = true WHERE id = $1 AND business_id = $2",
          [c.id, businessId, c.newPrice, now],
        );
        await recordPriceChange(tx, businessId, c.id, c.oldPrice, c.newPrice, "bulk");
      }
    });
  }
  return { count: changes.length, skipped: rows.length - changes.length, preview: changes.slice(0, 50) };
}

// ---------- Bulk upload ----------

/**
 * One spreadsheet row, as text. A field is missing when the file has no such column (the product keeps
 * what it had), and "" when the column is there but the cell is empty.
 */
export const ImportRow = z.object({
  name: z.string().max(500).optional(),
  price: z.string().max(60).optional(),
  unit: z.string().max(200).optional(),
  sku: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  inStock: z.string().max(40).optional(),
  /** A link to the product's photo on the store's website: fetched after the import. */
  photoUrl: z.string().max(2000).optional(),
});
export const ImportRequest = z.object({
  rows: z.array(ImportRow).min(1).max(MAX_IMPORT_ROWS),
  /** Rows whose code (SKU), or else name, matches a listed product update it instead of adding a second one. */
  updateExisting: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});

/** "$1,250.00", "US$ 12", "12.5", "12,50" → dollars; an empty cell → no price; undefined when it isn't a price. */
export function parsePrice(raw: string | undefined): number | null | undefined {
  const s = (raw ?? "").trim();
  if (!s || /^(-|n\/?a|ask|poa|call)$/i.test(s)) return null;
  let digits = s.replace(/usd|us\$|\$/gi, "").replace(/\s/g, "");
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(digits) || /^\d+,\d{1,2}$/.test(digits)) digits = digits.replace(/\./g, "").replace(",", ".");
  else digits = digits.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return undefined;
  const value = Number(digits);
  return value <= 1_000_000 ? Math.round(value * 100) / 100 : undefined;
}

export function parseInStock(raw: string | undefined): boolean | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return true;
  if (["yes", "y", "true", "1", "in", "in stock", "instock", "available"].includes(s)) return true;
  if (["no", "n", "false", "0", "out", "out of stock", "outofstock", "sold out", "unavailable"].includes(s)) return false;
  return undefined;
}

export interface ImportRowResult {
  row: number;
  name: string;
  action: "add" | "update" | "unchanged" | "error";
  error?: string;
  /** Its photo link: fetched after the import, or the photo it has stays (added by hand, or from this link). */
  photo?: "fetch" | "keep";
  /** A photo link we can't use. The product is imported all the same. */
  photoError?: string;
}

interface Existing {
  id: string;
  name: string;
  sku: string | null;
  price_usd: string | null;
  unit: string | null;
  category: string | null;
  description: string;
  in_stock: boolean;
  photo_id: string | null;
  photo_source_url: string | null;
}

/** A photo link from a spreadsheet cell, tidied; null when it isn't a web address. */
export function checkPhotoLink(raw: string): string | null {
  const s = raw.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 2000) return null;
  try {
    const url = new URL(s);
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Queue products' photo links, one per product: the latest link wins, and its tries start again. */
async function queuePhotoLinks(db: Db, businessId: string, links: { productId: string; url: string }[], now: Date): Promise<void> {
  for (let i = 0; i < links.length; i += 1000) {
    const part = links.slice(i, i + 1000);
    await db.query(
      `INSERT INTO photo_fetches (offering_id, business_id, url, status, attempts, next_try_at, created_at, updated_at)
       SELECT id, $1, url, 'queued', 0, $4, $4, $4 FROM unnest($2::uuid[], $3::text[]) AS t(id, url)
       ON CONFLICT (offering_id) DO UPDATE SET url = excluded.url, status = 'queued', attempts = 0, error = NULL,
         next_try_at = excluded.next_try_at, updated_at = excluded.updated_at`,
      [businessId, part.map((l) => l.productId), part.map((l) => l.url), now],
    );
  }
}

export async function importProducts(db: Db, businessId: string, req: z.infer<typeof ImportRequest>, now: Date) {
  const existing = await db.query<Existing>(
    "SELECT id, name, sku, price_usd, unit, category, description, in_stock, photo_id, photo_source_url FROM offerings WHERE business_id = $1 AND archived_at IS NULL",
    [businessId],
  );
  const bySku = new Map(existing.filter((e) => e.sku).map((e) => [e.sku!.toLowerCase(), e]));
  const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
  const seen = new Set<string>();
  let room = MAX_PRODUCTS - existing.length;
  const results: ImportRowResult[] = [];
  const toAdd: { product: ProductInput; photo: string | null }[] = [];
  const toUpdate: { id: string; patch: ProductPatch }[] = [];
  /** Listed products whose photo comes from a link that's new to them. */
  const photoLinks: { productId: string; url: string }[] = [];
  const has = (v: string | undefined): v is string => v !== undefined;

  req.rows.forEach((raw, i) => {
    const row = i + 1;
    const name = (raw.name ?? "").trim().replace(/\s+/g, " ");
    const fail = (error: string) => results.push({ row, name, action: "error", error });
    if (!name) return fail("No product name");
    if (name.length > 120) return fail("The name is longer than 120 characters");
    const price = has(raw.price) ? parsePrice(raw.price) : null;
    if (price === undefined) return fail(`"${raw.price}" isn't a price`);
    const inStock = has(raw.inStock) ? parseInStock(raw.inStock) : true;
    if (inStock === undefined) return fail(`"${raw.inStock}" isn't yes or no`);
    const sku = has(raw.sku) ? (blank(raw.sku)?.slice(0, 60) ?? null) : null;
    const key = sku ? `sku:${sku.toLowerCase()}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) return fail(sku ? `The code ${sku} is in the file twice` : "This name is in the file twice");
    seen.add(key);

    // A photo link is checked now and fetched after the import; a bad one doesn't stop the product.
    const link = blank(raw.photoUrl);
    const photo = link ? checkPhotoLink(link) : null;
    const photoError = link && !photo ? "The photo link isn't a web address (it should start with https://)" : undefined;
    const done = (action: ImportRowResult["action"], photoAction?: "fetch" | "keep") => {
      results.push({ row, name, action, ...(photoAction ? { photo: photoAction } : {}), ...(photoError ? { photoError } : {}) });
    };

    const match = sku ? bySku.get(sku.toLowerCase()) : byName.get(name.toLowerCase());
    if (!match) {
      if (room <= 0) return fail(`A business can list up to ${MAX_PRODUCTS.toLocaleString("en")} products`);
      room--;
      toAdd.push({
        product: {
          name,
          description: (raw.description ?? "").trim().slice(0, 500),
          price,
          unit: blank(raw.unit)?.slice(0, 30) ?? null,
          sku,
          category: blank(raw.category)?.slice(0, 60) ?? null,
          inStock,
        },
        photo,
      });
      return done("add", photo ? "fetch" : undefined);
    }
    if (!req.updateExisting) return done("unchanged");
    // A photo the owner added by hand stays, and so does one already from this link.
    const photoAction = !photo ? undefined : match.photo_id && (!match.photo_source_url || match.photo_source_url === photo) ? "keep" : "fetch";
    if (photoAction === "fetch") photoLinks.push({ productId: match.id, url: photo! });

    // Only the columns the file has; an empty description cell keeps what the owner wrote.
    const patch: ProductPatch = { name };
    if (has(raw.price)) patch.price = price;
    if (has(raw.unit)) patch.unit = blank(raw.unit)?.slice(0, 30) ?? null;
    if (has(raw.category)) patch.category = blank(raw.category)?.slice(0, 60) ?? null;
    if (has(raw.description) && raw.description.trim()) patch.description = raw.description.trim().slice(0, 500);
    if (has(raw.inStock)) patch.inStock = inStock;
    const same =
      patch.name === match.name &&
      (patch.price === undefined || patch.price === dollars(match.price_usd)) &&
      (patch.unit === undefined || patch.unit === match.unit) &&
      (patch.category === undefined || patch.category === match.category) &&
      (patch.description === undefined || patch.description === match.description) &&
      (patch.inStock === undefined || patch.inStock === match.in_stock);
    if (same) return done("unchanged", photoAction);
    toUpdate.push({ id: match.id, patch });
    done("update", photoAction);
  });

  if (!req.dryRun && (toAdd.length || toUpdate.length || photoLinks.length)) {
    await db.transaction(async (tx) => {
      for (const a of toAdd) {
        const added = await insertProduct(tx, businessId, a.product, now, "import");
        if (a.photo) photoLinks.push({ productId: added.id, url: a.photo });
      }
      for (const u of toUpdate) await applyPatch(tx, businessId, u.id, u.patch, now, "import");
      await queuePhotoLinks(tx, businessId, photoLinks, now);
    });
  }
  const count = (a: ImportRowResult["action"]) => results.filter((r) => r.action === a).length;
  const photos = (a: "fetch" | "keep") => results.filter((r) => r.photo === a).length;
  return {
    added: count("add"),
    updated: count("update"),
    unchanged: count("unchanged"),
    errors: count("error"),
    photos: { fetch: photos("fetch"), keep: photos("keep"), problems: results.filter((r) => r.photoError).length },
    rows: results,
  };
}

// ---------- Photos ----------

export const PhotoUpload = z.object({
  contentType: z.string().max(40),
  dataBase64: z.string().max(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4),
});
type PhotoUpload = z.infer<typeof PhotoUpload>;

/** JPEG, PNG or WebP by their first bytes, whatever the upload claimed. */
function looksLikeImage(b: Buffer): boolean {
  const jpeg = b[0] === 0xff && b[1] === 0xd8;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";
  return jpeg || png || webp;
}

async function savePhoto(db: Db, store: FileStore, businessId: string, kind: string, upload: PhotoUpload): Promise<string> {
  if (!PHOTO_TYPES[upload.contentType]) throw new CatalogError("Photos must be JPEG, PNG or WebP.");
  const data = Buffer.from(upload.dataBase64, "base64");
  if (!data.length || data.length > MAX_PHOTO_BYTES) throw new CatalogError("Each photo must be under 2 MB.");
  if (!looksLikeImage(data)) throw new CatalogError("That file isn't a photo.");
  return storePhoto(db, store, businessId, kind, data, upload.contentType);
}

async function storePhoto(db: Db, store: FileStore, businessId: string, kind: string, data: Buffer, contentType: string): Promise<string> {
  const id = crypto.randomUUID();
  const key = `photos/${businessId}/${id}.${PHOTO_TYPES[contentType]}`;
  await store.put(key, data, contentType);
  await db.query("INSERT INTO business_photos (id, business_id, kind, storage_key, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6)", [
    id,
    businessId,
    kind,
    key,
    contentType,
    data.length,
  ]);
  return id;
}

/**
 * A photo fetched from a product's link (a JPEG, already made smaller): on the product in place of any
 * photo it had. Nothing happens when the product was taken down, or its link changed, meanwhile.
 */
export async function attachLinkedPhoto(db: Db, store: FileStore, businessId: string, productId: string, url: string, data: Buffer, now: Date): Promise<boolean> {
  const product = await one<{ photo_id: string | null }>(
    db,
    `SELECT o.photo_id FROM offerings o JOIN photo_fetches f ON f.offering_id = o.id
      WHERE o.id = $1 AND o.business_id = $2 AND o.archived_at IS NULL AND f.url = $3`,
    [productId, businessId, url],
  );
  if (!product) return false;
  const photoId = await storePhoto(db, store, businessId, "product", data, "image/jpeg");
  await db.query("UPDATE offerings SET photo_id = $3, photo_source_url = $4, updated_at = $5, catalog_dirty = true WHERE id = $1 AND business_id = $2", [
    productId,
    businessId,
    photoId,
    url,
    now,
  ]);
  if (product.photo_id) await deletePhoto(db, store, businessId, product.photo_id);
  return true;
}

export async function setProductPhoto(db: Db, store: FileStore, businessId: string, productId: string, upload: PhotoUpload, now: Date): Promise<string> {
  if (!isUuid(productId)) throw new CatalogError("Product not found", 404);
  const product = await one<{ photo_id: string | null }>(db, "SELECT photo_id FROM offerings WHERE id = $1 AND business_id = $2 AND archived_at IS NULL", [productId, businessId]);
  if (!product) throw new CatalogError("Product not found", 404);
  const photoId = await savePhoto(db, store, businessId, "product", upload);
  // Added by hand: it wins over any photo link still waiting for this product.
  await db.query("UPDATE offerings SET photo_id = $3, photo_source_url = NULL, updated_at = $4, catalog_dirty = true WHERE id = $1 AND business_id = $2", [
    productId,
    businessId,
    photoId,
    now,
  ]);
  await db.query("DELETE FROM photo_fetches WHERE offering_id = $1", [productId]);
  if (product.photo_id) await deletePhoto(db, store, businessId, product.photo_id);
  return photoId;
}

export async function removeProductPhoto(db: Db, store: FileStore, businessId: string, productId: string, now: Date): Promise<void> {
  if (!isUuid(productId)) throw new CatalogError("Product not found", 404);
  const product = await one<{ photo_id: string | null }>(db, "SELECT photo_id FROM offerings WHERE id = $1 AND business_id = $2", [productId, businessId]);
  if (!product) throw new CatalogError("Product not found", 404);
  await db.query("DELETE FROM photo_fetches WHERE offering_id = $1", [productId]);
  if (!product.photo_id) return;
  await db.query("UPDATE offerings SET photo_id = NULL, photo_source_url = NULL, updated_at = $3, catalog_dirty = true WHERE id = $1 AND business_id = $2", [
    productId,
    businessId,
    now,
  ]);
  await deletePhoto(db, store, businessId, product.photo_id);
}

/** Every live product's name and code, for matching photo files to products in the browser. */
export async function productIndex(db: Db, businessId: string): Promise<{ id: string; name: string; sku: string | null; hasPhoto: boolean }[]> {
  const rows = await db.query<{ id: string; name: string; sku: string | null; photo_id: string | null }>(
    "SELECT id, name, sku, photo_id FROM offerings WHERE business_id = $1 AND archived_at IS NULL ORDER BY lower(name) LIMIT 30000",
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku, hasPhoto: r.photo_id != null }));
}

export async function addBusinessPhoto(db: Db, store: FileStore, businessId: string, kind: "shopfront" | "inside", upload: PhotoUpload): Promise<string> {
  const n = (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM business_photos WHERE business_id = $1 AND kind IN ('shopfront', 'inside')", [businessId]))!.n;
  if (n >= MAX_BUSINESS_PHOTOS) throw new CatalogError(`A business can show up to ${MAX_BUSINESS_PHOTOS} photos. Remove one first.`);
  return savePhoto(db, store, businessId, kind, upload);
}

export async function businessPhotos(db: Db, businessId: string) {
  return db.query<{ id: string; kind: string; created_at: Date }>(
    "SELECT id, kind, created_at FROM business_photos WHERE business_id = $1 AND kind IN ('shopfront', 'inside') ORDER BY created_at",
    [businessId],
  );
}

export async function deletePhoto(db: Db, store: FileStore, businessId: string, photoId: string): Promise<boolean> {
  if (!isUuid(photoId)) return false;
  const row = await one<{ storage_key: string }>(db, "DELETE FROM business_photos WHERE id = $1 AND business_id = $2 RETURNING storage_key", [photoId, businessId]);
  if (!row) return false;
  await store.delete(row.storage_key);
  return true;
}
