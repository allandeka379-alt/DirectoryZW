import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchBusinesses } from "../src/directory/search.js";
import { testApp, type TestApp } from "./helpers.js";

let app: TestApp;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

function near(name: string) {
  const a = app.services.gazetteer.match(name)!;
  return { lat: a.lat, lng: a.lng };
}

const search = (categorySlug: string | null, text: string, where?: string, minVerified = 3) =>
  searchBusinesses(app.db, app.services.taxonomy, {
    categorySlug,
    text,
    ...(where ? near(where) : {}),
    limit: 8,
    minVerified,
  });

describe("searchBusinesses", () => {
  it("shows verified businesses first and fills with unverified ones when there are too few", async () => {
    const hits = await search("plumbing", "plumber", "Mabelreign");
    expect(hits.map((h) => h.name)).toEqual([
      "QuickFix Plumbing (sample)",
      "Hatfield Plumbing Works (sample)",
      "Waterfalls Plumbers (sample)",
    ]);
    expect(hits.map((h) => h.verification)).toEqual(["verified", "verified", "registered"]);
    expect(hits[0]!.distanceKm).toBeLessThan(1);
  });

  it("hides unverified businesses once enough verified ones match", async () => {
    const hits = await search("plumbing", "plumber", "Mabelreign", 2);
    expect(hits.every((h) => h.verification === "verified")).toBe(true);
  });

  it("only shows verified businesses in high-scam categories", async () => {
    const hits = await search("rentals", "room to rent", "Epworth");
    expect(hits.map((h) => h.name)).toEqual(["Greendale Rentals (sample)"]);
  });

  it("leaves out businesses too far away", async () => {
    const hits = await search("solar", "solar installer", "Hillside");
    expect(hits.map((h) => h.name)).toEqual(["Brightside Solar Bulawayo (sample)"]);
  });

  it("finds businesses by keywords when there is no category", async () => {
    const hits = await search(null, "samsung 55 inch", "Avondale");
    expect(hits.map((h) => h.name)).toContain("Avondale Electronics (sample)");
  });

  it("never returns anything for blocked or restricted categories", async () => {
    expect(await search("blocked_drugs", "weed", "Avondale")).toEqual([]);
    expect(await search("pharmacy", "pharmacy", "Avondale")).toEqual([]);
  });

  it("skips paused businesses", async () => {
    await app.db.query("UPDATE businesses SET status = 'paused' WHERE name = 'QuickFix Plumbing (sample)'");
    const hits = await search("plumbing", "plumber", "Mabelreign");
    expect(hits.map((h) => h.name)).not.toContain("QuickFix Plumbing (sample)");
    await app.db.query("UPDATE businesses SET status = 'active' WHERE name = 'QuickFix Plumbing (sample)'");
  });
});
