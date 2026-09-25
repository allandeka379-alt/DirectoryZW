import { one } from "../db/client.js";
import { getBusiness } from "../directory/businesses.js";
import { getIntroduction } from "../directory/introductions.js";
import { replaceOfferings } from "../directory/offerings.js";
import { MAX_JOB_ATTEMPTS, type JobHandler } from "../jobs/queue.js";
import { applyRetention } from "../privacy.js";
import type { Channel } from "../whatsapp/types.js";
import type { Services } from "./context.js";
import * as copy from "./copy.js";
import { Ids } from "./ids.js";
import { getContactById } from "./store.js";

/** Background jobs the conversation schedules. */
export function jobHandlers(svc: Services): Record<string, JobHandler> {
  return {
    /** A few days after a customer connects with a business, ask how it went. */
    follow_up: async (payload) => {
      const intro = await getIntroduction(svc.db, String(payload.introductionId ?? ""));
      if (!intro || intro.followed_up_at || intro.outcome) return;
      const [business, customer] = await Promise.all([
        getBusiness(svc.db, intro.business_id),
        getContactById(svc.db, intro.contact_id),
      ]);
      if (!business || !customer || customer.is_blocked) return;
      await svc.messenger.notify("customer", customer.wa_id, copy.followUp(intro.id, business.name), {
        name: svc.config.whatsapp.templates.followUp,
        params: [business.name],
        quickReplies: [
          { id: Ids.feedback(intro.id, "sorted"), title: "Yes, sorted" },
          { id: Ids.feedback(intro.id, "not_yet"), title: "Not yet" },
          { id: Ids.feedback(intro.id, "no_reply"), title: "They didn't reply" },
        ],
      });
      await svc.db.query("UPDATE introductions SET followed_up_at = now() WHERE id = $1", [intro.id]);
    },

    /** A WhatsApp send that failed with an error worth retrying. */
    resend: async (payload, job) => {
      await svc.messenger.resend(String(payload.rowId), payload.channel as Channel, String(payload.to), job.attempts >= MAX_JOB_ATTEMPTS);
    },

    /** Once a day: delete old chats and the words in old requests, per the retention settings. */
    retention: async () => {
      const now = svc.now();
      try {
        const result = await applyRetention(svc.db, now, svc.config.retention);
        svc.log.info({ ...result }, "Retention clean-up done");
      } finally {
        await svc.jobs.enqueue("retention", {}, nextDailyRun(now));
      }
    },

    /** A field agent photographed a price list: read it into the listing. */
    read_price_list: async (payload) => {
      if (!svc.vision) return;
      // Over today's Claude budget: try again tomorrow rather than failing.
      if (!(await svc.budget.allows())) {
        await svc.jobs.enqueue("read_price_list", payload, nextDailyRun(svc.now()));
        return;
      }
      const photo = await one<{ id: string; business_id: string; storage_key: string; content_type: string }>(
        svc.db,
        "SELECT id, business_id, storage_key, content_type FROM business_photos WHERE id = $1 AND kind = 'price_list'",
        [String(payload.photoId ?? "")],
      );
      if (!photo) return;
      const data = await svc.store.get(photo.storage_key);
      if (!data) return;
      const list = await svc.vision.readPriceList({ data, mimeType: photo.content_type });
      // Throwing lets the queue retry a failed read; a photo that simply isn't a price list is left alone.
      if (!list) throw new Error("Price list could not be read");
      if (list.is_price_list && list.items.length) await replaceOfferings(svc.db, photo.business_id, list.items, photo.id);
    },

    /** Every Monday: tell each listed business how many searches it appeared in and how many customers it got. */
    weekly_summaries: async () => {
      const now = svc.now();
      try {
        await sendWeeklySummaries(svc, new Date(now.getTime() - 7 * 24 * 3600_000));
      } finally {
        await svc.jobs.enqueue("weekly_summaries", {}, nextWeeklyRun(now));
      }
    },
  };
}

/** Summaries go only to businesses that had some activity, which keeps WhatsApp costs down. Returns how many were sent. */
export async function sendWeeklySummaries(svc: Services, since: Date): Promise<number> {
  const rows = await svc.db.query<{ name: string; phone: string; shown: number; intros: number }>(
    `SELECT b.name, b.phone,
       (SELECT count(*)::int FROM request_results rr JOIN requests r ON r.id = rr.request_id
         WHERE rr.business_id = b.id AND r.created_at > $1) AS shown,
       (SELECT count(*)::int FROM introductions i WHERE i.business_id = b.id AND i.created_at > $1) AS intros
     FROM businesses b
     WHERE b.status = 'active' AND b.opted_in_at IS NOT NULL`,
    [since],
  );
  let sent = 0;
  for (const b of rows) {
    if (b.shown === 0 && b.intros === 0) continue;
    await svc.messenger.notify("business", b.phone, copy.weeklySummary(svc.config.brandName, b.name, b.shown, b.intros), {
      name: svc.config.whatsapp.templates.weeklySummary,
      params: [b.name, String(b.shown), String(b.intros)],
    });
    sent++;
  }
  return sent;
}

/** Next Monday 06:00 UTC (08:00 in Harare), strictly after `now`. */
export function nextWeeklyRun(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  let add = (1 - d.getUTCDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now.getTime()) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

/** Next 01:00 UTC (03:00 in Harare), strictly after `now`. */
export function nextDailyRun(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Make sure recurring jobs are queued (called at startup). */
export async function scheduleRecurringJobs(svc: Services): Promise<void> {
  const recurring: [string, Date][] = [
    ["weekly_summaries", nextWeeklyRun(svc.now())],
    ["retention", nextDailyRun(svc.now())],
  ];
  for (const [kind, runAt] of recurring) {
    const queued = await svc.db.query("SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1", [kind]);
    if (!queued.length) await svc.jobs.enqueue(kind, {}, runAt);
  }
}
