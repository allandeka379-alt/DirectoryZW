import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { createBusiness, TRADES } from "../directory/businesses.js";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { normalizeZimPhone } from "../text.js";

/** A website registration waits this long for its code to arrive on WhatsApp. */
export const REGISTRATION_HOURS = 48;
/** "REG-123456" anywhere in a message, however it's spaced or cased. */
export const REGISTRATION_CODE = /\bREG[-\s]?(\d{6})\b/i;

export const WebRegistration = z.object({
  name: z.string().trim().min(2).max(80),
  categories: z.array(z.string().max(60)).min(1).max(3),
  description: z.string().trim().max(300).default(""),
  areaId: z.number().int().positive(),
  address: z.string().trim().max(200).default(""),
  /** The number customers contact the business on. */
  phone: z.string().min(9).max(20),
  hours: z.string().trim().max(120).default(""),
  email: z.union([z.string().trim().email().max(200), z.literal("")]).default(""),
  website: z.string().trim().max(200).default(""),
  trade: z.enum(TRADES).default("retail"),
  /** The owner agreed to the business terms and to receive customers' messages. */
  consent: z.literal(true),
});
export type WebRegistration = z.infer<typeof WebRegistration>;

type Details = Omit<WebRegistration, "consent" | "phone"> & { phone: string };

export type StartResult = { ok: true; code: string; expiresAt: Date } | { ok: false; error: string };

export async function startWebRegistration(
  deps: { db: Db; taxonomy: Taxonomy; gazetteer: Gazetteer },
  input: WebRegistration,
  now: Date,
  hours = REGISTRATION_HOURS,
): Promise<StartResult> {
  const phone = normalizeZimPhone(input.phone);
  if (!phone) return { ok: false, error: "The phone number doesn't look right. Use a number like 0771 234 567." };
  const bad = input.categories.filter((s) => {
    const c = deps.taxonomy.get(s);
    return !c || c.risk === "blocked" || c.risk === "restricted";
  });
  if (bad.length) return { ok: false, error: "One of the categories can't be listed. Pick another." };
  if (!deps.gazetteer.get(input.areaId)) return { ok: false, error: "Pick your area from the list." };
  const details: Details = { ...input, phone };
  delete (details as Partial<WebRegistration>).consent;
  const expiresAt = new Date(now.getTime() + hours * 3600_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `REG-${crypto.randomInt(100000, 1000000)}`;
    const row = await one<{ code: string }>(
      deps.db,
      "INSERT INTO web_registrations (code, details, expires_at) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code",
      [code, JSON.stringify(details), expiresAt],
    );
    if (row) return { ok: true, code, expiresAt };
  }
  return { ok: false, error: "Something went wrong. Please try again." };
}

export type CompleteResult =
  | { status: "created" | "exists" | "claimed"; businessId: string; name: string }
  | { status: "unknown" | "expired" | "used" };

interface RegistrationRow {
  id: string;
  details: Details;
  expires_at: Date;
  completed_at: Date | null;
  business_id: string | null;
}

/** The owner sent their code from WhatsApp: create the listing, owned by that WhatsApp contact. */
export async function completeWebRegistration(
  deps: { db: Db; gazetteer: Gazetteer },
  rawCode: string,
  ownerContactId: string,
  now: Date,
): Promise<CompleteResult> {
  const digits = REGISTRATION_CODE.exec(rawCode)?.[1];
  if (!digits) return { status: "unknown" };
  const reg = await one<RegistrationRow>(
    deps.db,
    "SELECT id, details, expires_at, completed_at, business_id FROM web_registrations WHERE code = $1",
    [`REG-${digits}`],
  );
  if (!reg) return { status: "unknown" };
  if (new Date(reg.expires_at) <= now) return { status: reg.completed_at ? "used" : "expired" };
  if (reg.completed_at) return claimListing(deps.db, reg, ownerContactId);
  return listRegistration(deps, reg, ownerContactId, now);
}

/**
 * The code of a registration our team listed before launch: whoever sends it becomes the owner,
 * while nobody manages the listing yet (they may message us from another number than the
 * business's). Sending it again later is the listing they already have.
 */
async function claimListing(db: Db, reg: RegistrationRow, contactId: string): Promise<CompleteResult> {
  if (!reg.business_id) return { status: "used" };
  const claimed = await one<{ id: string; name: string }>(
    db,
    `UPDATE businesses SET owner_contact_id = $2, updated_at = now()
      WHERE id = $1 AND owner_contact_id IS NULL AND status <> 'removed' RETURNING id, name`,
    [reg.business_id, contactId],
  );
  if (claimed) {
    await db.query("INSERT INTO ops_audit (actor, action, target, details) VALUES ('system', 'business.claimed', $1, '{}')", [claimed.id]);
    return { status: "claimed", businessId: claimed.id, name: claimed.name };
  }
  const own = await one<{ id: string; name: string }>(
    db,
    "SELECT id, name FROM businesses WHERE id = $1 AND owner_contact_id = $2 AND status <> 'removed'",
    [reg.business_id, contactId],
  );
  return own ? { status: "exists", businessId: own.id, name: own.name } : { status: "used" };
}

/** Wrong registration codes a number may send in a day: six digits could otherwise be guessed. */
export const WRONG_CODES_PER_DAY = 5;

/** Wrong codes are counted by a hash of the WhatsApp ID, so deleting their data doesn't reset the count. */
export function codeSender(waId: string): string {
  return crypto.createHash("sha256").update(`code:${waId}`).digest("hex");
}

/**
 * Before launch, owners can't send their code on WhatsApp: the team calls them and lists the
 * business from the admin portal. Nobody manages it until its number messages us ("my business").
 */
export async function listWebRegistration(deps: { db: Db; gazetteer: Gazetteer }, id: string, now: Date): Promise<CompleteResult> {
  const reg = await one<RegistrationRow>(
    deps.db,
    "SELECT id, details, expires_at, completed_at, business_id FROM web_registrations WHERE id = $1",
    [id],
  );
  if (!reg) return { status: "unknown" };
  if (reg.completed_at) return { status: "used" };
  return listRegistration(deps, reg, null, now);
}

/** Create the listing from a registration's form, and close the registration. */
async function listRegistration(
  deps: { db: Db; gazetteer: Gazetteer },
  reg: RegistrationRow,
  ownerContactId: string | null,
  now: Date,
): Promise<CompleteResult> {
  const d = reg.details;

  // Sending the same code twice, or registering the same name again: the listing they already have.
  const existing = await one<{ id: string; name: string }>(
    deps.db,
    ownerContactId
      ? "SELECT id, name FROM businesses WHERE owner_contact_id = $1 AND lower(name) = lower($2) AND status <> 'removed'"
      : "SELECT id, name FROM businesses WHERE phone = $1 AND lower(name) = lower($2) AND status <> 'removed'",
    [ownerContactId ?? d.phone, d.name],
  );
  const area = deps.gazetteer.get(d.areaId);
  const businessId =
    existing?.id ??
    (await createBusiness(deps.db, {
      name: d.name,
      description: d.description,
      phone: d.phone,
      areaId: area?.id ?? null,
      lat: area?.lat ?? null,
      lng: area?.lng ?? null,
      categories: d.categories,
      trade: d.trade,
      source: "self",
      ownerContactId,
      optedIn: true,
    }));
  if (!existing) {
    await deps.db.query("UPDATE businesses SET address = $2, hours = $3, email = $4, website = $5 WHERE id = $1", [
      businessId,
      d.address || null,
      d.hours,
      d.email || null,
      d.website || null,
    ]);
  }
  // Done: keep only that it happened, not the form.
  await deps.db.query("UPDATE web_registrations SET completed_at = $2, business_id = $3, details = '{}'::jsonb WHERE id = $1", [reg.id, now, businessId]);
  return { status: existing ? "exists" : "created", businessId, name: existing?.name ?? d.name };
}
