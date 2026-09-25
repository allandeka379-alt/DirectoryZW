import { getBusiness } from "../directory/businesses.js";
import { getIntroduction } from "../directory/introductions.js";
import type { JobHandler } from "../jobs/queue.js";
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

/** Make sure recurring jobs are queued (called at startup). */
export async function scheduleRecurringJobs(svc: Services): Promise<void> {
  const queued = await svc.db.query("SELECT 1 FROM jobs WHERE kind = 'weekly_summaries' AND status IN ('queued', 'running') LIMIT 1");
  if (!queued.length) await svc.jobs.enqueue("weekly_summaries", {}, nextWeeklyRun(svc.now()));
}
