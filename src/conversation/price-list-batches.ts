import { alertOnClaudeError, describeError } from "../ai/errors.js";
import { isReadableImage } from "../ai/vision.js";
import { one } from "../db/client.js";
import { replaceOfferings } from "../directory/offerings.js";
import type { Services } from "./context.js";

/** How often queued field price lists are sent off, and finished batches collected. */
export const PRICE_LIST_BATCH_EVERY_MS = 20 * 60_000;
/** A photo that fails this many batches is given up on (the team can see it on the System screen). */
const MAX_ATTEMPTS = 3;
const PHOTOS_PER_BATCH = 50;

/** A field agent's price-list photo goes in the queue for the next batch. */
export async function queuePriceListRead(svc: Services, photoId: string): Promise<void> {
  await svc.db.query(
    `INSERT INTO price_list_reads (photo_id) SELECT id FROM business_photos WHERE id = $1 AND kind = 'price_list'
     ON CONFLICT (photo_id) DO UPDATE SET status = 'queued', batch_id = NULL, attempts = 0, error = NULL, updated_at = now()`,
    [photoId],
  );
}

/**
 * Save the price lists from batches that have finished (retrying photos that failed), then send
 * queued photos off in a new batch, within the day's Claude budget.
 */
export async function runPriceListBatches(svc: Services): Promise<{ collected: number; submitted: number }> {
  const batches = svc.priceListBatches;
  if (!batches) return { collected: 0, submitted: 0 };
  let collected = 0;

  const open = await svc.db.query<{ batch_id: string }>(
    "SELECT DISTINCT batch_id FROM price_list_reads WHERE status = 'submitted' AND batch_id IS NOT NULL",
  );
  for (const { batch_id: batchId } of open) {
    let reads;
    try {
      reads = await batches.collect(batchId);
    } catch (err) {
      svc.log.error({ err: describeError(err), batchId }, "Couldn't collect a price-list batch");
      continue;
    }
    if (!reads) continue;
    for (const read of reads) {
      collected++;
      if (read.list) {
        const photo = await one<{ business_id: string }>(svc.db, "SELECT business_id FROM business_photos WHERE id = $1", [read.photoId]);
        // A photo that simply isn't a price list is left alone.
        if (photo && read.list.is_price_list && read.list.items.length) await replaceOfferings(svc.db, photo.business_id, read.list.items, read.photoId);
        await svc.db.query("UPDATE price_list_reads SET status = 'done', error = NULL, updated_at = now() WHERE photo_id = $1", [read.photoId]);
      } else {
        await svc.db.query(
          `UPDATE price_list_reads SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, batch_id = NULL,
             error = $3, updated_at = now() WHERE photo_id = $1`,
          [read.photoId, MAX_ATTEMPTS, (read.error ?? "no answer").slice(0, 300)],
        );
      }
    }
    // Anything the batch didn't mention goes back in the queue.
    await svc.db.query(
      "UPDATE price_list_reads SET status = 'queued', batch_id = NULL, updated_at = now() WHERE batch_id = $1 AND status = 'submitted'",
      [batchId],
    );
    svc.log.info({ batchId, reads: reads.length }, "Collected a price-list batch");
  }

  if (!(await svc.budget.allows())) return { collected, submitted: 0 };
  const queued = await svc.db.query<{ photo_id: string; storage_key: string; content_type: string }>(
    `SELECT r.photo_id, p.storage_key, p.content_type FROM price_list_reads r JOIN business_photos p ON p.id = r.photo_id
      WHERE r.status = 'queued' ORDER BY r.created_at LIMIT $1`,
    [PHOTOS_PER_BATCH],
  );
  const photos = [];
  for (const q of queued) {
    const data = await svc.store.get(q.storage_key);
    const image = data ? { data, mimeType: q.content_type } : undefined;
    if (!image || !isReadableImage(image)) {
      await svc.db.query("UPDATE price_list_reads SET status = 'failed', error = $2, updated_at = now() WHERE photo_id = $1", [
        q.photo_id,
        image ? "not a photo Claude can read" : "photo missing from storage",
      ]);
      continue;
    }
    photos.push({ photoId: q.photo_id, image });
  }
  if (!photos.length) return { collected, submitted: 0 };
  try {
    const batchId = await batches.submit(photos);
    await svc.db.query(
      "UPDATE price_list_reads SET status = 'submitted', batch_id = $2, attempts = attempts + 1, updated_at = now() WHERE photo_id = ANY($1::uuid[])",
      [photos.map((p) => p.photoId), batchId],
    );
    svc.log.info({ batchId, photos: photos.length }, "Sent field price lists to the Batch API");
    return { collected, submitted: photos.length };
  } catch (err) {
    svc.log.error({ err: describeError(err) }, "Couldn't send field price lists to the Batch API");
    alertOnClaudeError(err, svc.alerts);
    return { collected, submitted: 0 };
  }
}
