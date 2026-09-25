import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { createUser, hashPassword, verifyPassword } from "../src/ops/accounts.js";
import { testApp, type TestApp } from "./helpers.js";

const OPS_TOKEN = "shared-ops-token-for-scripts";
let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp({ OPS_TOKEN });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

const call = (method: "GET" | "POST", url: string, token?: string, payload?: object) =>
  server.inject({
    method,
    url: `/ops/api${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {}),
  });

async function signIn(email: string, password: string): Promise<string> {
  const res = await call("POST", "/login", undefined, { email, password });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

describe("passwords", () => {
  it("are stored as scrypt hashes and checked in constant time", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
  });
});

describe("ops accounts", () => {
  let adminToken = "";
  let staffPassword = "";

  it("needs a sign-in; the shared token still works for scripts", async () => {
    expect((await call("GET", "/summary")).statusCode).toBe(401);
    expect((await call("GET", "/summary", "not-the-token")).statusCode).toBe(401);
    expect((await call("GET", "/me", OPS_TOKEN)).json()).toEqual({ userId: null, name: "ops token", role: "admin" });
  });

  it("lets an admin add people, who then sign in with their own password", async () => {
    await createUser(app.db, { name: "Ruth Admin", email: "ruth@example.com", role: "admin", password: "ruth-password-1" });
    adminToken = await signIn("Ruth@Example.com ", "ruth-password-1");
    expect((await call("GET", "/me", adminToken)).json()).toMatchObject({ name: "Ruth Admin", role: "admin" });

    const created = await call("POST", "/users", adminToken, { name: "Sam Staff", email: "sam@example.com" });
    expect(created.statusCode).toBe(201);
    staffPassword = created.json().password;
    expect(staffPassword).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect((await call("POST", "/users", adminToken, { name: "Sam Again", email: "SAM@example.com" })).statusCode).toBe(409);
  });

  it("keeps staff out of admin-only actions", async () => {
    const staff = await signIn("sam@example.com", staffPassword);
    expect((await call("GET", "/summary", staff)).statusCode).toBe(200);
    expect((await call("GET", "/users", staff)).statusCode).toBe(403);
    expect((await call("POST", "/agents", staff, { name: "Rogue Agent" })).statusCode).toBe(403);
    expect((await call("GET", "/activity", staff)).statusCode).toBe(403);

    // Staff can verify a listing, and it's recorded under their name.
    const [biz] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE verification = 'registered' LIMIT 1");
    expect((await call("POST", `/businesses/${biz!.id}/verify`, staff, {})).statusCode).toBe(200);
    const [row] = await app.db.query<{ verified_by: string }>("SELECT verified_by FROM businesses WHERE id = $1", [biz!.id]);
    expect(row?.verified_by).toBe("Sam Staff");
    // Hiding a listing is fine; removing it is for admins.
    expect((await call("POST", `/businesses/${biz!.id}/status`, staff, { status: "removed" })).statusCode).toBe(403);
  });

  it("records who did what", async () => {
    const activity = (await call("GET", "/activity", adminToken)).json() as { actor: string; action: string }[];
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: "Sam Staff", action: "business.verify" }),
        expect.objectContaining({ actor: "Ruth Admin", action: "user.create" }),
        expect.objectContaining({ actor: "Sam Staff", action: "login" }),
      ]),
    );
  });

  it("locks an email after repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i++) expect((await call("POST", "/login", undefined, { email: "sam@example.com", password: "guess" })).statusCode).toBe(401);
    expect((await call("POST", "/login", undefined, { email: "sam@example.com", password: staffPassword })).statusCode).toBe(429);
    expect((await call("POST", "/login", undefined, { email: "nobody@example.com", password: "guess" })).statusCode).toBe(401);
  });

  it("signs people out when their password changes or their account is switched off", async () => {
    const users = (await call("GET", "/users", adminToken)).json() as { id: string; email: string }[];
    const sam = users.find((u) => u.email === "sam@example.com")!;
    const reset = (await call("POST", `/users/${sam.id}`, adminToken, { resetPassword: true })).json();
    expect(reset.password).toBeTruthy();

    const ruth = users.find((u) => u.email === "ruth@example.com")!;
    expect((await call("POST", `/users/${ruth.id}`, adminToken, { active: false })).statusCode).toBe(400); // not yourself

    const second = await signIn("ruth@example.com", "ruth-password-1");
    expect((await call("POST", "/me/password", second, { current: "wrong", password: "a-new-password" })).statusCode).toBe(403);
    expect((await call("POST", "/me/password", second, { current: "ruth-password-1", password: "a-new-password" })).json()).toMatchObject({ ok: true });
    expect((await call("GET", "/me", adminToken)).statusCode).toBe(401); // every session ended
    const fresh = await signIn("ruth@example.com", "a-new-password");

    await call("POST", `/users/${sam.id}`, fresh, { active: false });
    app.advanceHours(0.3); // past the lockout from the previous test
    expect((await call("POST", "/login", undefined, { email: "sam@example.com", password: reset.password })).statusCode).toBe(401);
    await call("POST", "/logout", fresh);
    expect((await call("GET", "/me", fresh)).statusCode).toBe(401);
  });
});
