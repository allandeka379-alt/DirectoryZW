import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "./businesses.js";

export interface Introduction {
  id: string;
  ref_code: string;
  request_id: string | null;
  contact_id: string;
  business_id: string;
  outcome: "sorted" | "not_yet" | "no_reply" | null;
  rating: number | null;
  followed_up_at: Date | null;
  created_at: Date;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0 or 1

export function generateRefCode(length = 5): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Record that a customer chose to contact a business. The reference code proves the lead came from us. */
export async function createIntroduction(
  db: Db,
  input: { requestId: string | null; contactId: string; businessId: string },
): Promise<Introduction> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db.query<Introduction>(
      `INSERT INTO introductions (ref_code, request_id, contact_id, business_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (ref_code) DO NOTHING RETURNING *`,
      [generateRefCode(), input.requestId, input.contactId, input.businessId],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error("Could not generate a unique reference code");
}

export async function getIntroduction(db: Db, id: string): Promise<Introduction | undefined> {
  if (!isUuid(id)) return undefined;
  return one<Introduction>(db, "SELECT * FROM introductions WHERE id = $1", [id]);
}

/** A link that opens a WhatsApp chat with the business, message already typed. */
export function waMeLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}
