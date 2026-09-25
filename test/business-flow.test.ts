import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchBusinesses } from "../src/directory/search.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

function as(owner: string) {
  return {
    say: (text: string) => app.send("business", owner, { type: "text", text }, "Tafadzwa"),
    tap: (title: string) => app.tap(title, "business", owner),
    last: () => textOf(app.last("business", owner)),
  };
}

async function solarNearBorrowdale() {
  const a = app.services.gazetteer.match("Borrowdale")!;
  const hits = await searchBusinesses(app.db, app.services.taxonomy, {
    categorySlug: "solar",
    text: "solar",
    lat: a.lat,
    lng: a.lng,
    limit: 8,
    minVerified: 3,
  });
  return hits.map((h) => h.name);
}

describe("business number", () => {
  it("lets a business list itself, then manage the listing", async () => {
    const owner = "263779999991";
    const b = as(owner);
    await b.say("hello");
    expect(b.last()).toContain("List your business free");
    await b.tap("List my business");
    await b.say("Tafadzwa Solar Solutions");
    await b.say("We sell and install solar systems and inverters");
    expect(b.last()).toContain("Solar systems and installers");
    await b.tap("Yes, that's right");
    expect(app.last("business", owner).kind).toBe("location_request");
    await b.say("Borrowdale");
    await b.tap("This number");
    await b.tap("I agree");
    expect(b.last()).toContain("You're listed");

    const [row] = await app.db.query("SELECT verification, source, phone, status FROM businesses WHERE name = $1", [
      "Tafadzwa Solar Solutions",
    ]);
    expect(row).toEqual({ verification: "registered", source: "self", phone: owner, status: "active" });
    expect(await solarNearBorrowdale()).toContain("Tafadzwa Solar Solutions");

    await b.say("summary");
    expect(b.last()).toContain("last 7 days");
    await b.say("pause");
    expect(await solarNearBorrowdale()).not.toContain("Tafadzwa Solar Solutions");
    await b.say("resume");
    expect(await solarNearBorrowdale()).toContain("Tafadzwa Solar Solutions");
  });

  it("asks again when a step's answer doesn't fit, and can be cancelled", async () => {
    const b = as("263779999992");
    await b.say("register");
    await b.say("Mai Chipo Cakes");
    await b.say("xyzzy");
    expect(b.last()).toContain("couldn't tell which category");
    await b.say("cancel");
    expect(b.last()).toContain("Registration cancelled");
  });

  it("recognises a business a field agent registered when its number writes in", async () => {
    const phone = await app.phoneOf("PowerLine Electricians (sample)");
    const b = as(phone);
    await b.say("hi");
    expect(b.last()).toContain("PowerLine Electricians");
    expect(b.last()).toContain("Verified");
  });
});
