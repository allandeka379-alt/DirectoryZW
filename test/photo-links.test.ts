import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchPhotos } from "../public/app/photos.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { fetchPhotoLink, isPublicAddress, PhotoLinkError, shrinkLinkedPhoto, type FetchedPhoto } from "../src/web/photo-links.js";
import { testApp, type TestApp } from "./helpers.js";
import { dashboardOf } from "./shops.js";

const png = (width: number, height: number, alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 20, g: 110, b: 80, alpha } } }).png().toBuffer();

describe("which addresses a photo link may reach", () => {
  it("only the public internet", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "41.221.144.10", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::7f00:1",
      "not an address",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetching a photo link", () => {
  let site: http.Server;
  let base = "";
  let photo: Buffer;

  beforeAll(async () => {
    photo = await png(40, 30);
    site = http.createServer((req, res) => {
      if (req.url === "/photo.png") return res.writeHead(200, { "content-type": "image/png" }).end(photo);
      if (req.url === "/moved") return res.writeHead(302, { location: "/photo.png" }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/huge") return res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.alloc(3 * 1024 * 1024));
      if (req.url === "/down") return res.writeHead(503).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

  // The local test site is on this machine, which real links may never reach: `anywhere` lets tests in.
  const get = (path: string, opts: { maxBytes?: number } = {}) => fetchPhotoLink(`${base}${path}`, { anywhere: true, ...opts });

  it("downloads a photo, following redirects", async () => {
    expect((await get("/photo.png")).data.equals(photo)).toBe(true);
    expect((await get("/moved")).data.equals(photo)).toBe(true);
  });

  it("says what went wrong, and whether trying again may help", async () => {
    await expect(get("/nothing-here.jpg")).rejects.toMatchObject({ message: 'The link gives "not found" (404)', retry: false });
    await expect(get("/down")).rejects.toMatchObject({ message: "The website had a problem (503)", retry: true });
    await expect(get("/loop")).rejects.toThrow("too many times");
    await expect(get("/huge", { maxBytes: 1024 * 1024 })).rejects.toThrow("bigger than 15 MB");
  });

  it("never reaches this machine or a private network, whatever the link says", async () => {
    await expect(fetchPhotoLink(`${base}/photo.png`)).rejects.toThrow("unusual port");
    await expect(fetchPhotoLink("http://127.0.0.1/photo.png")).rejects.toThrow("private address");
    await expect(fetchPhotoLink("http://169.254.169.254/latest/meta-data")).rejects.toThrow("private address");
    await expect(fetchPhotoLink("http://[::1]/photo.png")).rejects.toThrow("private address");
    // By name too: localhost is looked up, and refused before anything connects.
    await expect(fetchPhotoLink("http://localhost/photo.png")).rejects.toThrow("private address");
    await expect(fetchPhotoLink("ftp://example.com/photo.png")).rejects.toThrow("must start with https://");
    await expect(fetchPhotoLink("https://user:secret@example.com/photo.png")).rejects.toThrow("password");
  });
});

describe("making a linked photo like the others", () => {
  it("shrinks it to the size of a photo added by hand, as a JPEG", async () => {
    const out = await shrinkLinkedPhoto(await png(3000, 2000));
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1280, height: 853 });
    // Small photos aren't blown up.
    expect(await sharp(await shrinkLinkedPhoto(await png(400, 300))).metadata()).toMatchObject({ width: 400, height: 300 });
  });

  it("puts a see-through photo on white, not black", async () => {
    const out = await shrinkLinkedPhoto(await png(200, 200, 0));
    const { channels } = await sharp(out).stats();
    expect(channels.slice(0, 3).every((c) => c.mean > 250)).toBe(true);
  });

  it("lets nothing else through", async () => {
    await expect(shrinkLinkedPhoto(Buffer.from("<html>Not found</html>"))).rejects.toThrow("isn't a photo");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(shrinkLinkedPhoto(svg)).rejects.toThrow(PhotoLinkError);
  });
});

describe("photo links in a product upload", () => {
  let app: TestApp;
  let server: FastifyInstance;
  // What each link on the "internet" gives; a missing link is a 404.
  const web = new Map<string, Buffer | PhotoLinkError>();
  const fetches: string[] = [];
  const fetchPhoto = async (url: string): Promise<FetchedPhoto> => {
    fetches.push(url);
    const answer = web.get(url);
    if (!answer) throw new PhotoLinkError('The link gives "not found" (404)');
    if (answer instanceof PhotoLinkError) throw answer;
    return { data: answer, contentType: "image/png" };
  };

  beforeAll(async () => {
    app = await testApp({}, { fetchPhoto });
    server = createServer({ logger: false });
    registerRoutes(server, app);
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
    await app.close();
  });

  /** Background jobs until nothing is due, a second apart as they'd run. */
  async function runJobs(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      app.advanceHours(1 / 3600);
      if (!(await app.runJobs())) break;
    }
  }
  const productNamed = async (name: string) =>
    (await app.db.query<{ id: string; photo_id: string | null; photo_source_url: string | null }>("SELECT id, photo_id, photo_source_url FROM offerings WHERE name = $1", [name]))[0]!;

  const cdn = (file: string) => `https://cdn.example.co.zw/products/${file}`;
  const rows = [
    { name: "Capri fridge 300L", price: "589", photoUrl: cdn("fridge.png") },
    { name: "Defy stove 4 plate", price: "380", photoUrl: cdn("stove.png") },
    { name: "Russell Hobbs kettle", price: "25", photoUrl: "kettle.jpg" },
    { name: "Toaster 2 slice", price: "30", photoUrl: cdn("missing.jpg") },
  ];

  it("checks the links, then fetches them in the background after the import", async () => {
    web.set(cdn("fridge.png"), await png(2400, 1600, 0));
    web.set(cdn("stove.png"), await png(800, 800));
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");

    const check = (await shop.call("POST", "/products/import", { rows, dryRun: true })).json();
    expect(check.photos).toEqual({ fetch: 3, keep: 0, problems: 1 });
    expect(check.rows[2]).toMatchObject({ name: "Russell Hobbs kettle", action: "add", photoError: expect.stringContaining("isn't a web address") });
    expect(await app.db.query("SELECT 1 FROM photo_fetches")).toHaveLength(0);

    const done = (await shop.call("POST", "/products/import", { rows })).json();
    expect(done).toMatchObject({ added: 4, photos: { fetch: 3, keep: 0, problems: 1 } });
    expect((await shop.call("GET", "/photo-links")).json()).toMatchObject({ waiting: 3, failed: 0 });

    await runJobs();
    const status = (await shop.call("GET", "/photo-links")).json();
    expect(status).toMatchObject({
      waiting: 0,
      failed: 1,
      failures: [{ name: "Toaster 2 slice", url: cdn("missing.jpg"), error: 'The link gives "not found" (404)' }],
    });

    const fridge = await productNamed("Capri fridge 300L");
    expect(fridge.photo_source_url).toBe(cdn("fridge.png"));
    const [stored] = await app.db.query<{ storage_key: string; content_type: string }>("SELECT storage_key, content_type FROM business_photos WHERE id = $1", [
      fridge.photo_id,
    ]);
    expect(stored!.content_type).toBe("image/jpeg");
    expect(await sharp((await app.files.get(stored!.storage_key))!).metadata()).toMatchObject({ format: "jpeg", width: 1280, height: 853 });
    // Customers see it: on the product's page, and served to WhatsApp's catalog.
    expect((await server.inject({ url: `/media/products/${fridge.photo_id}` })).statusCode).toBe(200);
    expect((await productNamed("Russell Hobbs kettle")).photo_id).toBeNull();
  });

  it("doesn't fetch again what it has, and keeps a photo the owner added by hand", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    fetches.length = 0;
    // The same list again: only the toaster's link, which didn't work, is tried again.
    const again = (await shop.call("POST", "/products/import", { rows, dryRun: true })).json();
    expect(again.photos).toEqual({ fetch: 1, keep: 2, problems: 1 });

    // The owner puts their own photo on the stove; a new link in a list doesn't replace it.
    const stove = await productNamed("Defy stove 4 plate");
    await shop.photo(stove.id);
    expect((await productNamed("Defy stove 4 plate")).photo_source_url).toBeNull();
    // A new link for the fridge replaces the photo from the old one.
    web.set(cdn("fridge-2.png"), await png(900, 600));
    const changed = rows.map((r) => ({ ...r, photoUrl: r.name.startsWith("Capri") ? cdn("fridge-2.png") : r.name.startsWith("Defy") ? cdn("stove-2.png") : r.photoUrl }));
    const result = (await shop.call("POST", "/products/import", { rows: changed })).json();
    expect(result.photos).toEqual({ fetch: 2, keep: 1, problems: 1 });
    const oldPhoto = (await productNamed("Capri fridge 300L")).photo_id;
    await runJobs();
    const fridge = await productNamed("Capri fridge 300L");
    expect(fridge.photo_source_url).toBe(cdn("fridge-2.png"));
    expect(fridge.photo_id).not.toBe(oldPhoto);
    // The old photo is deleted with its file.
    expect(await app.db.query("SELECT 1 FROM business_photos WHERE id = $1", [oldPhoto])).toHaveLength(0);
    expect(fetches).not.toContain(cdn("stove-2.png"));
  });

  it("tries a link that may work later again, then gives up, and the owner can try again or clear the list", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    web.set(cdn("blender.png"), new PhotoLinkError("The website didn't answer", true));
    await shop.call("POST", "/products/import", { rows: [{ name: "Blender 1.5L", price: "40", photoUrl: cdn("blender.png") }] });
    await runJobs();
    // Waiting for its second try, five minutes on.
    expect((await shop.call("GET", "/photo-links")).json()).toMatchObject({ waiting: 1, failed: 1 });
    app.advanceHours(6 / 60);
    await runJobs();
    app.advanceHours(11 / 60);
    await runJobs();
    const status = (await shop.call("GET", "/photo-links")).json();
    expect(status).toMatchObject({ waiting: 0, failed: 2 });
    expect(status.failures.map((f: { name: string }) => f.name)).toEqual(["Blender 1.5L", "Toaster 2 slice"]);

    // The website is back: "Try them again".
    web.set(cdn("blender.png"), await png(600, 600));
    expect((await shop.call("POST", "/photo-links/retry")).json()).toEqual({ retrying: 2 });
    await runJobs();
    expect((await productNamed("Blender 1.5L")).photo_source_url).toBe(cdn("blender.png"));
    expect((await shop.call("GET", "/photo-links")).json()).toMatchObject({ waiting: 0, failed: 1 });
    expect((await shop.call("POST", "/photo-links/clear")).json()).toEqual({ cleared: 1 });
    expect((await shop.call("GET", "/photo-links")).json()).toMatchObject({ waiting: 0, failed: 0, failures: [] });
  });

  it("drops a waiting link when its product is taken down", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    await shop.call("POST", "/products/import", { rows: [{ name: "Microwave 20L", price: "70", photoUrl: cdn("microwave.png") }] });
    const microwave = await productNamed("Microwave 20L");
    await shop.archive([microwave.id]);
    expect(await app.db.query("SELECT 1 FROM photo_fetches WHERE offering_id = $1", [microwave.id])).toHaveLength(0);
  });

  it("lists every product, for matching photo files to them", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const index = (await shop.call("GET", "/products/index")).json() as { name: string; hasPhoto: boolean }[];
    expect(index.find((p) => p.name === "Capri fridge 300L")).toMatchObject({ hasPhoto: true });
    expect(index.find((p) => p.name === "Russell Hobbs kettle")).toMatchObject({ hasPhoto: false });
    expect(index.some((p) => p.name === "Microwave 20L")).toBe(false);
  });
});

describe("matching photo files to products", () => {
  const products = [
    { id: "1", name: "PPC Cement 50kg", sku: "CEM-50" },
    { id: "2", name: "Défy fridge 300L", sku: null },
    { id: "3", name: "Paint 5L", sku: "CEM" },
  ];
  const match = (file: string) => {
    const [m] = matchPhotos([file], products);
    return m!.product ? `${m!.product.id} by ${m!.by}` : null;
  };

  it("by the product's code, then its name, however the file is written", () => {
    expect(match("CEM-50.jpg")).toBe("1 by code");
    expect(match("cem_50.JPEG")).toBe("1 by code");
    expect(match("defy-fridge-300l.png")).toBe("2 by name");
    expect(match("PPC Cement 50kg.webp")).toBe("1 by name");
  });

  it("allows for a copy number, but never cuts a code short", () => {
    expect(match("CEM-50 (2).jpg")).toBe("1 by code");
    expect(match("CEM-50_1.jpg")).toBe("1 by code");
    // "CEM-5" isn't "CEM": the dash and number are part of the code.
    expect(match("CEM-5.jpg")).toBeNull();
    expect(match("IMG_2041.jpg")).toBeNull();
  });
});
