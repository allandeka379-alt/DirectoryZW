import { trainClassifier } from "../ai/learning.js";
import { getBusiness } from "../directory/businesses.js";
import { getIntroduction } from "../directory/introductions.js";
import { reportsWaiting } from "../directory/trust.js";
import { MAX_JOB_ATTEMPTS, type JobHandler } from "../jobs/queue.js";
import { applyRetention } from "../privacy.js";
import { fetchQueuedPhotos } from "../web/photo-links.js";
import { markAllForCatalog, syncCatalog } from "../whatsapp/catalog.js";
import type { Channel } from "../whatsapp/types.js";
import { sendProductAlerts } from "./alerts.js";
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
      // Sent inside the window "Connect me" opened, it's free (FOLLOW_UP_DELAY_HOURS, default 20).
      // Later than that, it's a paid template, sent only with PAID_FOLLOW_UPS.
      const sent = await svc.messenger.notify(
        customer.channel,
        customer.wa_id,
        copy.followUp(intro.id, business.name),
        {
          name: svc.config.whatsapp.templates.followUp,
          params: [business.name],
          quickReplies: [
            { id: Ids.feedback(intro.id, "sorted"), title: "Yes, sorted" },
            { id: Ids.feedback(intro.id, "not_yet"), title: "Not yet" },
            { id: Ids.feedback(intro.id, "failed"), title: "It didn't work out" },
          ],
        },
        { freeOnly: !svc.config.paidFollowUps },
      );
      if (sent === "skipped") svc.log.info({ introductionId: intro.id }, "Follow-up skipped: the customer's free window had closed");
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

    /**
     * Every hour: remind the team about customer reports left open for a day. We tell customers
     * we look into every report, so none should sit unread.
     */
    report_reminders: async () => {
      try {
        const waiting = await reportsWaiting(svc.db);
        if (waiting.length) {
          const names = [...new Set(waiting.map((w) => w.business))].slice(0, 5).join(", ");
          svc.alerts.send(
            "reports-waiting",
            `${waiting.length} customer report${waiting.length === 1 ? " has" : "s have"} waited more than a day (${names}). ` +
              "We tell customers we look into every report: see Reports in the ops console.",
          );
        }
      } finally {
        await svc.jobs.enqueue("report_reminders", {}, new Date(svc.now().getTime() + 3600_000));
      }
    },

    /** Every hour: relearn the word-shape classifier from the phrasebook's newest answers. */
    retrain_classifier: async () => {
      try {
        if (svc.config.local.classifierMin > 0) svc.classifier = await trainClassifier({ ...svc });
      } finally {
        await svc.jobs.enqueue("retrain_classifier", {}, new Date(svc.now().getTime() + 3600_000));
      }
    },

    /** Shortly after a business's products change: tell customers who were waiting for them. */
    product_alerts: async (payload) => {
      await sendProductAlerts(svc, String(payload.businessId ?? ""), new Date(String(payload.since ?? svc.now().toISOString())));
    },

    /** Shortly after products change: send the WhatsApp catalog what changed. */
    catalog_sync: async () => {
      if (!svc.catalog) return;
      const result = await syncCatalog(svc.db, svc.catalog, { publicBaseUrl: svc.config.publicBaseUrl, lexicon: svc.lexicon, log: svc.log });
      if (result.more) {
        await svc.jobs.enqueueOnce("catalog_sync", "all", {}, new Date(svc.now().getTime() + 5_000));
        return;
      }
      // Meta checks a batch after accepting it: look again in a minute, so anything it refused shows
      // in the admin portal soon, not at the next change. Batches stuck for an hour wait for the daily check.
      const [checking] = await svc.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM catalog_batches WHERE status = 'pending' AND created_at > now() - interval '1 hour'",
      );
      if (checking?.n) await svc.jobs.enqueueOnce("catalog_sync", "all", {}, new Date(svc.now().getTime() + 60_000));
    },

    /** Photos from the links in product uploads: a few at a time, until none are waiting. */
    photo_fetches: async () => {
      const round = await fetchQueuedPhotos({ db: svc.db, store: svc.store, log: svc.log, now: svc.now, fetch: svc.fetchPhoto });
      if (round.done || round.failed) svc.log.info({ done: round.done, failed: round.failed }, "Photos fetched from links");
      // New photos go to the WhatsApp catalog too.
      if (round.businesses.length && svc.catalog) await svc.jobs.enqueueOnce("catalog_sync", "all", {}, new Date(svc.now().getTime() + 10_000));
      if (round.next) await svc.jobs.enqueueOnce("photo_fetches", "all", {}, new Date(Math.max(round.next.getTime(), svc.now().getTime() + 1_000)));
    },

    /** Once a day: check every product against the catalog, so nothing missed stays missed. */
    catalog_reconcile: async () => {
      const now = svc.now();
      try {
        if (svc.catalog) {
          await markAllForCatalog(svc.db);
          await svc.jobs.enqueueOnce("catalog_sync", "all", {}, now);
        }
      } finally {
        await svc.jobs.enqueue("catalog_reconcile", {}, nextDailyRun(now));
      }
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

/**
 * Monday summaries, to businesses that had some activity. Off by default (WEEKLY_SUMMARIES):
 * owners see their week at the top of the business menu, which costs nothing. "window_only" sends
 * them free to businesses that wrote to us in the last 24 hours; "always" pays for templates.
 * Returns how many were sent.
 */
export async function sendWeeklySummaries(svc: Services, since: Date): Promise<number> {
  if (svc.config.weeklySummaries === "off") return 0;
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
    const result = await svc.messenger.notify(
      "business",
      b.phone,
      copy.weeklySummary(svc.config.brandName, b.name, b.shown, b.intros),
      { name: svc.config.whatsapp.templates.weeklySummary, params: [b.name, String(b.shown), String(b.intros)] },
      { freeOnly: svc.config.weeklySummaries === "window_only" },
    );
    if (result !== "skipped") sent++;
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
    ["retrain_classifier", new Date(svc.now().getTime() + 3600_000)],
    ["report_reminders", new Date(svc.now().getTime() + 3600_000)],
    ["catalog_reconcile", nextDailyRun(svc.now())],
  ];
  for (const [kind, runAt] of recurring) {
    const queued = await svc.db.query("SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') LIMIT 1", [kind]);
    if (!queued.length) await svc.jobs.enqueue(kind, {}, runAt);
  }
}
