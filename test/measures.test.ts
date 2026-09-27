import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { testApp, type TestApp } from "./helpers.js";

let app: TestApp;
let server: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

let n = 0;
const newCustomer = () => `26377444${String(++n).padStart(4, "0")}`;

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

type Summary = {
  verified_businesses: number;
  answered_30d: number;
  sorted_30d: number;
  customers_30d: number;
  returning_30d: number;
  owners: number;
  owners_active_30d: number;
  connections_verified_30d: number;
  verified_connected_30d: number;
};
const summary = async () => (await server.inject({ url: "/ops/api/summary" })).json() as Summary;

describe("launch measures on the Overview", () => {
  it("starts with nothing to measure", async () => {
    const s = await summary();
    expect(s).toMatchObject({
      answered_30d: 0,
      sorted_30d: 0,
      customers_30d: 0,
      returning_30d: 0,
      owners: 0,
      owners_active_30d: 0,
      connections_verified_30d: 0,
      verified_connected_30d: 0,
    });
    expect(s.verified_businesses).toBeGreaterThan(0);
  });

  it("counts final follow-up answers, customers who come back, owners who write in, and connections", async () => {
    // Three customers connect with three verified businesses.
    const sorted = as(newCustomer());
    await sorted.consented();
    await sorted.say("I need a samsung tv in Avondale");
    await sorted.tap("Avondale Electronics");
    await sorted.tap("Connect me");
    const noReply = as(newCustomer());
    await noReply.consented();
    await noReply.say("I need a plumber in Mabelreign");
    await noReply.tap("QuickFix");
    await noReply.tap("Connect me");
    const waiting = as(newCustomer());
    await waiting.consented();
    await waiting.say("I need an electrician in Belvedere");
    await waiting.tap("PowerLine");
    await waiting.tap("Connect me");

    // The next day: one got what they needed, one business didn't reply, and "Not yet" isn't a final answer.
    app.advanceHours(21);
    await app.runJobs();
    await sorted.tap("Yes, sorted");
    await sorted.tap("😀 Great");
    await noReply.tap("It didn't work out");
    await noReply.tap("They didn't reply");
    await waiting.tap("Not yet");

    // The first customer searches again, and their first search was three days ago.
    await sorted.say("I need a fridge in Borrowdale");
    await app.db.query("UPDATE requests SET created_at = created_at - interval '3 days' WHERE raw_text = 'I need a samsung tv in Avondale'");

    // One owner writes to the business number.
    await app.send("business", await app.phoneOf("Avondale Electronics (sample)"), { type: "text", text: "menu" });

    expect(await summary()).toMatchObject({
      answered_30d: 2,
      sorted_30d: 1,
      customers_30d: 3,
      returning_30d: 1,
      owners: 1,
      owners_active_30d: 1,
      connections_verified_30d: 3,
      verified_connected_30d: 3,
    });
  });
});
