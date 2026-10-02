import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { customerInsights, demandInsights, filterOptions, overviewInsights, supplyInsights } from "../ops/insights.js";
import { PERIOD_DAYS, type Period, periodFor, type Scope } from "../web/periods.js";

const Query = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (PERIOD_DAYS as readonly number[]).includes(d), "Pick 7, 30 or 90 days, or 12 months")
    .default(30),
  city: z.string().trim().min(1).max(80).optional(),
  area: z.coerce.number().int().positive().optional(),
  category: z.string().trim().min(1).max(60).optional(),
  group: z.string().trim().min(1).max(80).optional(),
});

/**
 * The admin portal's analytics pages (src/ops/insights.ts): an executive overview, demand, supply and
 * customer experience, for a period against the one before, narrowed by place and category.
 */
export function registerInsightRoutes(ops: FastifyInstance, app: App): void {
  const now = () => app.services.now();

  function read(req: FastifyRequest, reply: FastifyReply): { scope: Scope; period: Period } | undefined {
    const q = Query.safeParse(req.query);
    if (!q.success) {
      void reply.code(400).send({ error: q.error.issues[0]?.message ?? "Check the filters" });
      return undefined;
    }
    const { days, city, area, category, group } = q.data;
    return { scope: { city: city ?? null, areaId: area ?? null, category: category ?? null, group: group ?? null }, period: periodFor(days, now()) };
  }

  ops.get("/insights/options", async () => filterOptions(app.db));

  ops.get("/insights/overview", async (req, reply) => {
    const r = read(req, reply);
    return r && overviewInsights(app.db, r.scope, r.period);
  });

  ops.get("/insights/demand", async (req, reply) => {
    const r = read(req, reply);
    return r && demandInsights(app.db, r.scope, r.period);
  });

  ops.get("/insights/supply", async (req, reply) => {
    const r = read(req, reply);
    return r && supplyInsights(app.db, r.scope, r.period, now());
  });

  ops.get("/insights/customers", async (req, reply) => {
    const r = read(req, reply);
    return r && customerInsights(app.db, r.scope, r.period, now());
  });
}
