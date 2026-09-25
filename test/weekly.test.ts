import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextWeeklyRun } from "../src/conversation/followups.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

describe("nextWeeklyRun", () => {
  it("picks the next Monday at 06:00 UTC (08:00 in Harare)", () => {
    expect(nextWeeklyRun(new Date("2027-03-01T05:00:00Z")).toISOString()).toBe("2027-03-01T06:00:00.000Z"); // Monday, before
    expect(nextWeeklyRun(new Date("2027-03-01T06:00:00Z")).toISOString()).toBe("2027-03-08T06:00:00.000Z"); // Monday, on time
    expect(nextWeeklyRun(new Date("2027-03-03T12:00:00Z")).toISOString()).toBe("2027-03-08T06:00:00.000Z"); // Wednesday
    expect(nextWeeklyRun(new Date("2027-03-07T23:00:00Z")).toISOString()).toBe("2027-03-08T06:00:00.000Z"); // Sunday night
  });
});

describe("weekly business summaries", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("goes to businesses that were shown, then schedules next week", async () => {
    const customer = "263775550001";
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("I need a plumber in Mabelreign", customer);

    const firstRun = nextWeeklyRun(app.clock.now);
    app.clock.now = new Date(firstRun.getTime() + 1000);
    expect(await app.runJobs()).toBeGreaterThanOrEqual(1);

    const plumber = await app.phoneOf("QuickFix Plumbing (sample)");
    const summary = app.outbox("business", plumber).at(-1)!;
    expect(summary.template).toBe("weekly_summary");
    expect(textOf(summary.message)).toContain("Your week on TestDir");
    expect(textOf(summary.message)).toContain("Shown in 1 search");

    const quiet = await app.phoneOf("Avondale Electronics (sample)");
    expect(app.outbox("business", quiet)).toHaveLength(0);

    const next = await app.db.query<{ run_at: Date }>("SELECT run_at FROM jobs WHERE kind = 'weekly_summaries' AND status = 'queued'");
    expect(next).toHaveLength(1);
    expect(new Date(next[0]!.run_at).toISOString()).toBe(nextWeeklyRun(app.clock.now).toISOString());
  });
});
