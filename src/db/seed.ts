import { seedEntries } from "../ai/lexicon.js";
import type { Db } from "./client.js";
import { categories, relatedCategories } from "./seed-data/categories.js";
import { areas } from "./seed-data/areas.js";
import { sampleBusinesses } from "./seed-data/sample-businesses.js";

/** Insert or update the reference data every environment needs: categories, areas and the seed lexicon. */
export async function seedReferenceData(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const c of categories) {
      await tx.query(
        `INSERT INTO categories (slug, name, group_name, synonyms, risk, needs_location, related, short_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name, group_name = excluded.group_name,
           synonyms = excluded.synonyms, risk = excluded.risk, needs_location = excluded.needs_location,
           related = excluded.related, short_name = excluded.short_name`,
        [c.slug, c.name, c.group, c.synonyms, c.risk ?? "normal", c.needsLocation ?? true, relatedCategories[c.slug] ?? [], c.short ?? null],
      );
    }
    // New seed words are added, and ones nobody has reviewed follow the code. Words a person
    // approved, rejected or added stay as they are.
    await tx.query(
      `INSERT INTO lexicon (term, language, role, categories, family, action, is_root, gloss, status)
       SELECT e.term, e.language, e.role, ARRAY(SELECT jsonb_array_elements_text(e.categories)), e.family, e.action,
              e.is_root, e.gloss, e.status
         FROM jsonb_to_recordset($1::jsonb) AS e(term text, language text, role text, categories jsonb, family text,
              action text, is_root boolean, gloss text, status text)
       ON CONFLICT (term, language, role) DO UPDATE SET categories = excluded.categories, family = excluded.family,
         action = excluded.action, is_root = excluded.is_root, gloss = excluded.gloss
       WHERE lexicon.source = 'seed' AND lexicon.reviewed_by IS NULL`,
      [JSON.stringify(seedEntries().map(({ root, ...e }) => ({ ...e, is_root: root })))],
    );
    for (const a of areas) {
      await tx.query(
        `INSERT INTO areas (name, city, lat, lng, aliases) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, city) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, aliases = excluded.aliases`,
        [a.name, a.city, a.lat, a.lng, a.aliases ?? []],
      );
    }
  });
}

/** Load fictional businesses for local testing. Skips if any sample business already exists. */
export async function seedSampleBusinesses(db: Db): Promise<number> {
  const existing = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM businesses WHERE is_sample");
  if ((existing[0]?.n ?? 0) > 0) return 0;
  const areaRows = await db.query<{ id: number; name: string; lat: number; lng: number }>(
    "SELECT id, name, lat, lng FROM areas",
  );
  const byName = new Map(areaRows.map((a) => [a.name, a]));
  let n = 0;
  await db.transaction(async (tx) => {
    for (const [i, b] of sampleBusinesses.entries()) {
      const area = byName.get(b.area);
      if (!area) throw new Error(`Sample business ${b.name} has unknown area ${b.area}`);
      const phone = `26377000${String(1000 + i).padStart(4, "0")}`;
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO businesses (name, description, keywords, phone, area_id, lat, lng, verification,
           verified_at, verified_by, source, opted_in_at, is_sample)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'field', now(), true) RETURNING id`,
        [
          b.name,
          b.description,
          b.keywords ?? "",
          phone,
          area.id,
          area.lat,
          area.lng,
          b.verified ? "verified" : "registered",
          b.verified ? new Date() : null,
          b.verified ? "sample-seed" : null,
        ],
      );
      const id = rows[0]!.id;
      for (const slug of b.categories) {
        await tx.query("INSERT INTO business_categories (business_id, category_slug) VALUES ($1, $2)", [id, slug]);
      }
      n++;
    }
  });
  return n;
}
