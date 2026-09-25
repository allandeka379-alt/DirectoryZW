import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeOnlineFinder, checkReport } from "../src/ai/online-finder.js";
import { HttpSpeechToText } from "../src/ai/speech.js";
import { sanitizePriceList } from "../src/ai/vision.js";
import { silentLogger } from "../src/logger.js";
import { CloudMediaSource, MediaError } from "../src/whatsapp/media.js";

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WhatsApp media download", () => {
  it("looks up the media ID, then downloads the file with the same token", async () => {
    const { fn, calls } = fakeFetch([
      json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "audio/ogg; codecs=opus", file_size: 5 }),
      new Response(Buffer.from("hello")),
    ]);
    const media = new CloudMediaSource({ graphVersion: "v24.0", accessToken: "tok", maxBytes: 1000, fetchFn: fn });
    const file = await media.fetch("1234567890");
    expect(file.data.toString()).toBe("hello");
    expect(file.mimeType).toBe("audio/ogg");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v24.0/1234567890");
    expect(calls[1]!.url).toContain("lookaside.fbsbx.com");
    for (const c of calls) expect((c.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("refuses files over the size limit and unknown IDs", async () => {
    const big = fakeFetch([json({ url: "https://lookaside.fbsbx.com/x", mime_type: "image/jpeg", file_size: 5000 })]);
    const media = new CloudMediaSource({ graphVersion: "v24.0", accessToken: "tok", maxBytes: 1000, fetchFn: big.fn });
    await expect(media.fetch("1")).rejects.toMatchObject({ reason: "too_large" });

    const missing = fakeFetch([json({ error: "not found" }, 404)]);
    const media2 = new CloudMediaSource({ graphVersion: "v24.0", accessToken: "tok", maxBytes: 1000, fetchFn: missing.fn });
    await expect(media2.fetch("2")).rejects.toBeInstanceOf(MediaError);
    await expect(media2.fetch("../me")).rejects.toMatchObject({ reason: "not_found" }); // never requested
  });
});

describe("speech-to-text over HTTP", () => {
  it("sends the audio with language hints and reads the transcript", async () => {
    const { fn, calls } = fakeFetch([json({ text: "  ndoda   plumber ", language: "sn" })]);
    const stt = new HttpSpeechToText({ url: "https://stt.example/transcribe", token: "secret", languages: ["sn", "nd", "en"], fetchFn: fn });
    expect(await stt.transcribe({ data: Buffer.from("ogg"), mimeType: "audio/ogg" })).toEqual({ text: "ndoda plumber", language: "sn" });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Language-Hints"]).toBe("sn,nd,en");
    expect(headers["Content-Type"]).toBe("audio/ogg");
    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("returns null for silence and throws on errors", async () => {
    const silent = new HttpSpeechToText({ url: "https://stt.example", languages: ["sn"], fetchFn: fakeFetch([json({ text: "" })]).fn });
    expect(await silent.transcribe({ data: Buffer.from("x"), mimeType: "audio/ogg" })).toBeNull();
    const broken = new HttpSpeechToText({ url: "https://stt.example", languages: ["sn"], fetchFn: fakeFetch([json({}, 500)]).fn });
    await expect(broken.transcribe({ data: Buffer.from("x"), mimeType: "audio/ogg" })).rejects.toThrow("500");
  });
});

describe("price lists read from photos", () => {
  it("drops duplicates, blank names and impossible prices", () => {
    const list = sanitizePriceList({
      is_price_list: true,
      items: [
        { name: "  Cement\n50kg ", price_usd: 11.499, price_text: "$11.50" },
        { name: "cement 50kg", price_usd: 12, price_text: null },
        { name: " ", price_usd: 1, price_text: null },
        { name: "Sand", price_usd: -5, price_text: "ZiG 300" },
      ],
    });
    expect(list.items).toEqual([
      { name: "Cement 50kg", price_usd: 11.5, price_text: "$11.50" },
      { name: "Sand", price_usd: null, price_text: "ZiG 300" },
    ]);
    expect(sanitizePriceList({ is_price_list: false, items: [{ name: "x", price_usd: 1, price_text: null }] }).items).toEqual([]);
  });
});

describe("finding businesses online", () => {
  const searchResult = {
    type: "web_search_tool_result",
    tool_use_id: "srv_1",
    content: [
      { type: "web_search_result", url: "https://www.facebook.com/avondalegardens", title: "Avondale Gardens | Facebook", encrypted_content: "x", page_age: null },
      { type: "web_search_result", url: "https://venues.co.zw/rose-hall", title: "Rose Hall - Venues ZW", encrypted_content: "y", page_age: null },
    ],
  };
  const report = (businesses: unknown[]) => ({ type: "tool_use", id: "tu_1", name: "report_businesses", input: { businesses } });

  function fakeClient(responses: unknown[]) {
    const requests: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    } as unknown as Anthropic;
    return { client, requests };
  }

  it("resumes a paused search and keeps only results it can check", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "wedding venue avondale" } }, searchResult] },
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Here is what I found." },
          report([
            { name: "Avondale Gardens", phone: "+263 77 210 0001", what_they_offer: "Garden weddings", area: "Avondale", source_url: "https://facebook.com/avondalegardens/posts/1" },
            { name: "Made-up Venue", phone: "0772100003", what_they_offer: "Venue", area: null, source_url: "https://not-searched.example/venue" },
            { name: "Landline Hall", phone: "0242 123 456", what_they_offer: "Hall", area: null, source_url: "https://venues.co.zw/landline" },
            { name: "Avondale Gardens again", phone: "0772100001", what_they_offer: "Venue", area: null, source_url: "https://www.facebook.com/avondalegardens" },
            { name: "Rose Hall", phone: "0712 100 002", what_they_offer: "Hall hire\nfor 200", area: null, source_url: "https://venues.co.zw/rose-hall" },
          ]),
        ],
      },
    ]);
    const finder = new ClaudeOnlineFinder({ client, model: "claude-opus-5", brand: "TestDir", log: silentLogger });
    const results = await finder.find({ query: "wedding venue", categoryName: "Venues", place: "Avondale, Harare", city: "Harare" });

    expect(results).toEqual([
      { name: "Avondale Gardens", phone: "263772100001", description: "Garden weddings", area: "Avondale", sourceUrl: "https://facebook.com/avondalegardens/posts/1", sourceTitle: null },
      { name: "Rose Hall", phone: "263712100002", description: "Hall hire for 200", area: null, sourceUrl: "https://venues.co.zw/rose-hall", sourceTitle: "Rose Hall - Venues ZW" },
    ]);
    expect(requests).toHaveLength(2);
    const second = requests[1] as { messages: { role: string }[]; tools: Record<string, unknown>[] };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // no extra "continue" message
    expect(second.tools[0]).toMatchObject({ type: "web_search_20260209", max_uses: 3, user_location: { country: "ZW", city: "Harare" } });
    expect(second.tools[1]).toMatchObject({ name: "report_businesses", strict: true });
  });

  it("returns nothing when Claude doesn't report or the API fails", async () => {
    const quiet = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Nothing found." }] }]);
    const finder = new ClaudeOnlineFinder({ client: quiet.client, model: "m", brand: "b", log: silentLogger });
    expect(await finder.find({ query: "x", categoryName: null, place: null, city: null })).toEqual([]);

    const failing = fakeClient([new Error("overloaded")]);
    const finder2 = new ClaudeOnlineFinder({ client: failing.client, model: "m", brand: "b", log: silentLogger });
    expect(await finder2.find({ query: "x", categoryName: null, place: null, city: null })).toEqual([]);
  });

  it("rejects a malformed report", () => {
    expect(checkReport({ businesses: [{ name: "No phone" }] }, new Map())).toEqual([]);
  });
});
