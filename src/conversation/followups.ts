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
  };
}
