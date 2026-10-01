import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { testApp, type TestApp } from "./helpers.js";

// The website's own images and script, from public/site/assets at /assets/site/<name>.
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

describe("the website's asset folder", () => {
  it("serves its files with their types", async () => {
    const folder = new URL("../public/site/assets/", import.meta.url);
    const svg = fs.readdirSync(folder).find((f) => f.endsWith(".svg"));
    if (!svg) return; // nothing to serve yet
    const res = await server.inject({ url: `/assets/site/${svg}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("lets the browser check its copy of a file instead of downloading it again", async () => {
    const first = await server.inject({ url: "/assets/site.css" });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]{16}"$/);
    expect(first.headers["cache-control"]).toBe("no-cache");
    const again = await server.inject({ url: "/assets/site.css", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const changed = await server.inject({ url: "/assets/site.css", headers: { "if-none-match": '"something-else00"' } });
    expect(changed.statusCode).toBe(200);
  });

  it("serves nothing outside the folder, and no other kinds of file", async () => {
    for (const name of ["..%2Fsite.css", "..%2F..%2Fapp%2Fapp.js", "%2E%2E%2Findex.html", "index.html", "Bad.SVG", "a%00.svg", "nothing-here.svg"]) {
      expect((await server.inject({ url: `/assets/site/${name}` })).statusCode).toBe(404);
    }
  });
});
