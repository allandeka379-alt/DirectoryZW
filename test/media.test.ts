import { describe, expect, it } from "vitest";
import { HttpSpeechToText } from "../src/ai/speech.js";
import { sanitizePriceList } from "../src/ai/vision.js";
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

