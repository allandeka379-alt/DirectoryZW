import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebhookAlerts } from "../src/alerts.js";
import { GoogleSpeechToText, shortLanguage } from "../src/ai/google-speech.js";
import * as copy from "../src/conversation/copy.js";
import { judge, parseExamples, score } from "../src/eval/score.js";
import { silentLogger } from "../src/logger.js";
import { DiskStore, S3Store } from "../src/storage.js";
import { TEMPLATES, templatePayload, variableCount } from "../src/whatsapp/templates.js";

describe("photo storage", () => {
  it("deletes files from disk, and treats a missing file as already gone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = new DiskStore(dir);
    await store.put("photos/a/b.jpg", Buffer.from("jpeg"));
    expect((await store.get("photos/a/b.jpg"))?.toString()).toBe("jpeg");
    await store.delete("photos/a/b.jpg");
    await store.delete("photos/a/b.jpg");
    expect(await store.get("photos/a/b.jpg")).toBeUndefined();
    await expect(store.put("../escape.jpg", Buffer.from("x"))).rejects.toThrow("Unsafe");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores photos in an S3-compatible bucket under a prefix", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === "GetObjectCommand") {
          if (String(command.input.Key).endsWith("missing.jpg")) throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
          return { Body: { transformToByteArray: async () => new Uint8Array([106, 112, 103]) } };
        }
        return {};
      },
    };
    const store = await S3Store.create({ bucket: "photos-bucket", region: "auto", prefix: "whatsapp-directory" }, client as never);
    await store.put("photos/b1/p1.jpg", Buffer.from("jpg"), "image/jpeg");
    expect((await store.get("photos/b1/p1.jpg"))?.toString()).toBe("jpg");
    expect(await store.get("photos/b1/missing.jpg")).toBeUndefined();
    await store.delete("photos/b1/p1.jpg");
    expect(sent.map((s) => s.name)).toEqual(["PutObjectCommand", "GetObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    expect(sent[0]!.input).toMatchObject({ Bucket: "photos-bucket", Key: "whatsapp-directory/photos/b1/p1.jpg", ContentType: "image/jpeg" });
  });
});

describe("Google speech-to-text (Chirp 2)", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  function fakeGoogle(transcripts: Record<string, string>) {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(url), body });
      if (String(url).includes("oauth2")) {
        const assertion = new URLSearchParams(body).get("assertion")!;
        const [header, claims, signature] = assertion.split(".");
        const valid = crypto.verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url"));
        expect(valid).toBe(true);
        expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "stt@project.iam.gserviceaccount.com" });
        return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      }
      const language = (JSON.parse(body) as { config: { languageCodes: string[] } }).config.languageCodes[0]!;
      const text = transcripts[language];
      return Response.json(text ? { results: [{ alternatives: [{ transcript: text }], languageCode: language }] } : {});
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  const make = (fetchFn: typeof fetch) =>
    new GoogleSpeechToText({
      projectId: "my-project",
      location: "europe-west4",
      languages: ["sn-ZW", "zu-ZA", "en-US"],
      credentials: { client_email: "stt@project.iam.gserviceaccount.com", private_key: privateKey },
      fetchFn,
    });
  const audio = { data: Buffer.from("ogg opus"), mimeType: "audio/ogg" };

  it("signs in with the service account once, then tries languages in order until one hears something", async () => {
    const { fetchFn, calls } = fakeGoogle({ "zu-ZA": "ngifuna umakhenikha e Mpopoma" });
    const stt = make(fetchFn);
    expect(await stt.transcribe(audio)).toEqual({ text: "ngifuna umakhenikha e Mpopoma", language: "nd" });
    expect(calls.map((c) => (c.url.includes("oauth2") ? "token" : JSON.parse(c.body).config.languageCodes[0]))).toEqual(["token", "sn-ZW", "zu-ZA"]);
    expect(calls[1]!.url).toBe("https://europe-west4-speech.googleapis.com/v2/projects/my-project/locations/europe-west4/recognizers/_:recognize");
    expect(JSON.parse(calls[1]!.body).config.model).toBe("chirp_2");

    // The language of their last request goes first; the token is reused.
    calls.length = 0;
    await stt.transcribe(audio, { language: "nd" });
    expect(calls.map((c) => JSON.parse(c.body).config.languageCodes[0])).toEqual(["zu-ZA"]);
  });

  it("returns null when no language hears anything", async () => {
    const { fetchFn } = fakeGoogle({});
    expect(await make(fetchFn).transcribe(audio)).toBeNull();
    expect(shortLanguage("sn-ZW")).toBe("sn");
  });
});

describe("alerts", () => {
  it("posts each kind of alert at most once per quiet period", async () => {
    const posts: string[] = [];
    let now = new Date("2026-09-25T08:00:00Z");
    const alerts = new WebhookAlerts({
      webhookUrl: "https://hooks.example.com/abc",
      brand: "TestDir",
      log: silentLogger,
      now: () => now,
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)).text);
        return new Response("ok");
      }) as typeof fetch,
    });
    alerts.send("claude-auth", "Key rejected");
    alerts.send("claude-auth", "Key rejected");
    alerts.send("job:follow_up", "Job failed");
    now = new Date(now.getTime() + 31 * 60_000);
    alerts.send("claude-auth", "Key rejected");
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual(["⚠️ TestDir: Key rejected", "⚠️ TestDir: Job failed", "⚠️ TestDir: Key rejected"]);
    expect(alerts.recent.map((a) => a.key)).toEqual(["claude-auth", "job:follow_up", "claude-auth"]);
  });
});

describe("message templates", () => {
  it("have examples for every variable and buttons within WhatsApp's limits", () => {
    for (const t of TEMPLATES) {
      expect(variableCount(t.body), t.key).toBe(t.example.length);
      expect(t.quickReplies.length).toBeLessThanOrEqual(3);
      for (const b of t.quickReplies) expect(b.length).toBeLessThanOrEqual(25);
    }
    expect(templatePayload(TEMPLATES[1]!, "follow_up", "en")).toEqual({
      name: "follow_up",
      language: "en",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Did you get what you needed from {{1}}?", example: { body_text: [["QuickFix Plumbing"]] } },
        { type: "BUTTONS", buttons: ["Yes, sorted", "Not yet", "It didn't work out"].map((text) => ({ type: "QUICK_REPLY", text })) },
      ],
    });
  });

  it("offer the same buttons as the messages they stand in for", () => {
    const titles = (m: ReturnType<typeof copy.followUp>) => (m.kind === "buttons" ? m.buttons.map((b) => b.title) : []);
    expect(TEMPLATES.find((t) => t.key === "followUp")!.quickReplies).toEqual(titles(copy.followUp("i", "B")));
  });
});

describe("eval scoring", () => {
  it("scores intent, category and area, skipping fields an example doesn't label", () => {
    const [plumber, hello] = parseExamples(
      [
        '{"id":"a","text":"plumber in Avondale","language":"en","expect":{"intent":"search","category":"plumbing","area":"Avondale"},"source":"synthetic"}',
        "// comments and blank lines are skipped",
        "",
        '{"id":"b","text":"hi","language":"en","expect":{"intent":"greeting"},"source":"synthetic"}',
      ].join("\n"),
    );
    const outcomes = [
      judge(plumber!, { intent: "search", category: "plumbing", area: null }, 10),
      judge(hello!, { intent: "greeting", category: null, area: null }, 20),
    ];
    expect(score(outcomes)).toEqual({ n: 2, errors: 0, intent: 1, category: 1, area: 0, avgMs: 15 });
  });
});
