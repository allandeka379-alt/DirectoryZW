import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { GraphCatalog, type CatalogItem } from "../src/whatsapp/catalog.js";
import { CloudApiTransport, isRetryable, WhatsAppApiError } from "../src/whatsapp/transport.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

// Meta's side, without Meta: the requests we make and how we read the answers, from responses
// shaped like the ones Meta documents. And the engine's promise that one person's messages are
// handled in order.

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records each call and answers with the next canned response. */
function fakeFetch(...responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const headerOf = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("the Cloud API transport", () => {
  it("posts the message to our number with the token, and returns WhatsApp's message ID", async () => {
    const meta = fakeFetch({ status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.HBgM" }] } });
    const t = new CloudApiTransport({ graphVersion: "v23.0", accessToken: "token-1", phoneNumberId: "1234567890", log: silentLogger, fetchFn: meta.fn });
    const id = await t.send("customer", "263771234567", { kind: "text", text: "Hello" });
    expect(id).toBe("wamid.HBgM");
    const [call] = meta.calls;
    expect(call!.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(call!.init.method).toBe("POST");
    expect(headerOf(call!, "authorization")).toBe("Bearer token-1");
    expect(JSON.parse(String(call!.init.body))).toMatchObject({ messaging_product: "whatsapp", to: "263771234567", type: "text", text: { body: "Hello" } });
  });

  it("turns Meta's errors into errors we can tell apart", async () => {
    const closed = { error: { message: "Re-engagement message", type: "OAuthException", code: 131047 } };
    const limited = { error: { message: "Rate limit hit", type: "OAuthException", code: 130429 } };
    const meta = fakeFetch({ status: 400, body: closed }, { status: 400, body: limited }, { status: 500, body: {} });
    const t = new CloudApiTransport({ graphVersion: "v23.0", accessToken: "t", phoneNumberId: "1", log: silentLogger, fetchFn: meta.fn });
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

    const window = await failure(t.send("customer", "263771234567", { kind: "text", text: "Hi" }));
    expect(window).toBeInstanceOf(WhatsAppApiError);
    expect((window as WhatsAppApiError).status).toBe(400);
    expect((window as WhatsAppApiError).body).toEqual(closed);
    expect(isRetryable(window)).toBe(false); // the 24-hour window is closed: trying again won't help

    expect(isRetryable(await failure(t.send("customer", "263771234567", { kind: "text", text: "Hi" })))).toBe(true); // a rate limit passes
    expect(isRetryable(await failure(t.send("customer", "263771234567", { kind: "text", text: "Hi" })))).toBe(true); // Meta's own trouble
  });

  it("returns an empty ID when Meta accepts without one", async () => {
    const meta = fakeFetch({ status: 200, body: {} });
    const t = new CloudApiTransport({ graphVersion: "v23.0", accessToken: "t", phoneNumberId: "1", log: silentLogger, fetchFn: meta.fn });
    expect(await t.send("customer", "263771234567", { kind: "text", text: "Hi" })).toBe("");
  });
});

describe("the Meta catalog", () => {
  const item: CatalogItem = {
    retailerId: "3f2a9c1e-0000-4000-8000-000000000001",
    title: "Samsung 55-inch TV",
    description: "Smart TV",
    availability: "in stock",
    condition: "new",
    price: "589.00 USD",
    link: "https://findzim.test/p/3f2a9c1e",
    imageLink: "https://findzim.test/media/products/abc",
    brand: "TV Sales & Home",
  };

  it("sends changes and deletions as one items batch, and returns the handles", async () => {
    const meta = fakeFetch({ status: 200, body: { handles: ["AczM0NTE2"] } });
    const catalog = new GraphCatalog({ graphVersion: "v23.0", accessToken: "cat-token", catalogId: "987", log: silentLogger, fetch: meta.fn });
    expect(await catalog.batch([item], ["gone-1"])).toEqual(["AczM0NTE2"]);
    const [call] = meta.calls;
    expect(call!.url).toBe("https://graph.facebook.com/v23.0/987/items_batch");
    expect(headerOf(call!, "authorization")).toBe("Bearer cat-token");
    expect(JSON.parse(String(call!.init.body))).toEqual({
      item_type: "PRODUCT_ITEM",
      allow_upsert: true,
      requests: [
        {
          method: "UPDATE",
          data: {
            id: item.retailerId,
            title: item.title,
            description: item.description,
            availability: "in stock",
            condition: "new",
            price: "589.00 USD",
            link: item.link,
            image_link: item.imageLink,
            brand: item.brand,
          },
        },
        { method: "DELETE", data: { id: "gone-1" } },
      ],
    });
  });

  it("says why a batch was refused", async () => {
    const meta = fakeFetch({ status: 400, body: { error: { message: "Invalid catalog ID", code: 100 } } });
    const catalog = new GraphCatalog({ graphVersion: "v23.0", accessToken: "t", catalogId: "987", log: silentLogger, fetch: meta.fn });
    await expect(catalog.batch([item], [])).rejects.toThrow("Catalog batch refused (400): Invalid catalog ID");
  });

  it("reads a batch's status and the items Meta refused", async () => {
    const meta = fakeFetch(
      { status: 200, body: { data: [{ status: "in_progress", errors: [] }] } },
      { status: 200, body: { data: [{ status: "finished", errors: [{ id: item.retailerId, message: "The image link is broken" }] }] } },
    );
    const catalog = new GraphCatalog({ graphVersion: "v23.0", accessToken: "t", catalogId: "987", log: silentLogger, fetch: meta.fn });
    expect(await catalog.check("AczM0NTE2")).toEqual({ done: false, errors: [] });
    expect(await catalog.check("AczM0NTE2")).toEqual({ done: true, errors: [{ retailerId: item.retailerId, message: "The image link is broken" }] });
    expect(meta.calls[0]!.url).toBe("https://graph.facebook.com/v23.0/987/check_batch_request_status?handle=AczM0NTE2");
  });
});

describe("the conversation engine", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("handles one person's messages in the order they came, and different people's side by side", async () => {
    const a = "263773330001";
    const b = "263773330002";
    for (const who of [a, b]) {
      await app.say("hi", who);
      await app.tap("I agree", "customer", who);
    }
    // Sent together, without waiting: a search, then "menu".
    await Promise.all([app.say("I need a plumber in Mabelreign", a), app.say("menu", a), app.say("I need a plumber in Mabelreign", b)]);
    const replies = app.outbox("customer", a).slice(-2).map((m) => m.message);
    expect(replies[0]!.kind).toBe("list");
    expect(textOf(replies[1]!)).toContain("What are you looking for");
    expect(app.last("customer", b).kind).toBe("list");
  });
});
