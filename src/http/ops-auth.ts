import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { isUuid } from "../directory/businesses.js";
import {
  actorForSession,
  checkPassword,
  createUser,
  generatePassword,
  hasUsers,
  listUsers,
  logAction,
  login,
  LoginThrottle,
  logout,
  MIN_PASSWORD_LENGTH,
  ROLES,
  updateUser,
  type Actor,
} from "../ops/accounts.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const DEVELOPER: Actor = { userId: null, name: "developer", role: "admin" };
const TOKEN_ACTOR: Actor = { userId: null, name: "ops token", role: "admin" };

function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function sameSecret(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Who is calling the ops API: a person signed in with their own account, or a script using
 * OPS_TOKEN (treated as an admin). In development, with no OPS_TOKEN and no accounts yet,
 * the API is open so the console works out of the box.
 */
export function opsAuthHook(app: App) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routeOptions.url === "/ops/api/login") return;
    const token = bearer(req);
    if (token && app.config.opsToken && sameSecret(token, app.config.opsToken)) {
      req.actor = TOKEN_ACTOR;
      return;
    }
    const actor = token ? await actorForSession(app.db, token) : undefined;
    if (actor) {
      req.actor = actor;
      return;
    }
    if (!token && app.config.env !== "production" && !app.config.opsToken && !(await hasUsers(app.db))) {
      req.actor = DEVELOPER;
      return;
    }
    return reply.code(401).send({ error: "Please sign in" });
  };
}

/** The signed-in person. Only call inside the ops plugin, after the auth hook. */
export function actorOf(req: FastifyRequest): Actor {
  return req.actor ?? DEVELOPER;
}

/** Stops a request that needs an admin. Returns true when it did. */
export function refuseUnlessAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (actorOf(req).role === "admin") return false;
  void reply.code(403).send({ error: "Only an admin can do that" });
  return true;
}

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });

/** Signing in and out, your own password, and (admins) the team's accounts and activity log. */
export function registerAccountRoutes(ops: FastifyInstance, app: App): void {
  const throttle = new LoginThrottle(app.services.now);

  ops.post("/login", async (req, reply) => {
    const body = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Give your email and password" });
    const { email, password } = body.data;
    if (throttle.blocked(email)) return reply.code(429).send({ error: "Too many attempts. Try again in 15 minutes." });
    const result = await login(app.db, email, password, app.config.opsSessionHours);
    if (!result) {
      throttle.failed(email);
      return reply.code(401).send({ error: "Wrong email or password" });
    }
    throttle.succeeded(email);
    await logAction(app.db, { userId: result.user.id, name: result.user.name, role: result.user.role }, "login");
    return { token: result.token, user: result.user };
  });

  ops.post("/logout", async (req) => {
    const token = bearer(req);
    if (token) await logout(app.db, token);
    return { ok: true };
  });

  ops.get("/me", async (req) => actorOf(req));

  ops.post("/me/password", async (req, reply) => {
    const actor = actorOf(req);
    if (!actor.userId) return reply.code(400).send({ error: "Only personal accounts have a password" });
    const body = z.object({ current: z.string().max(200), password: z.string().min(MIN_PASSWORD_LENGTH).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters` });
    if (!(await checkPassword(app.db, actor.userId, body.data.current))) return reply.code(403).send({ error: "Your current password is wrong" });
    await updateUser(app.db, actor.userId, { password: body.data.password });
    await logAction(app.db, actor, "password.change", actor.userId);
    return { ok: true, signedOut: true };
  });

  ops.get("/users", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    return listUsers(app.db);
  });

  // New account. Without a password, one is generated and shown once, to pass on to the person.
  ops.post("/users", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().email().max(200),
        role: z.enum(ROLES).default("staff"),
        password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const password = body.data.password ?? generatePassword();
    try {
      const user = await createUser(app.db, { ...body.data, password });
      await logAction(app.db, actorOf(req), "user.create", user.id, { role: user.role });
      return reply.code(201).send({ user, password: body.data.password ? undefined : password });
    } catch (err) {
      if (String(err).includes("ops_users_email_key")) return reply.code(409).send({ error: "Someone already has that email" });
      throw err;
    }
  });

  // Change role, deactivate or reactivate, or issue a new password (shown once).
  ops.post("/users/:id", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const params = Id.safeParse(req.params);
    const body = z
      .object({ role: z.enum(ROLES).optional(), active: z.boolean().optional(), resetPassword: z.boolean().optional() })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a user ID and what to change" });
    const actor = actorOf(req);
    if (params.data.id === actor.userId && (body.data.role || body.data.active === false)) {
      return reply.code(400).send({ error: "You can't change your own role or switch off your own account" });
    }
    const password = body.data.resetPassword ? generatePassword() : undefined;
    const user = await updateUser(app.db, params.data.id, { role: body.data.role, active: body.data.active, password });
    if (!user) return reply.code(404).send({ error: "User not found" });
    await logAction(app.db, actor, "user.update", user.id, {
      role: body.data.role,
      active: body.data.active,
      passwordReset: !!password,
    });
    return { user, password };
  });

  ops.get("/activity", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const q = req.query as { limit?: string };
    return app.db.query(
      "SELECT actor, action, target, details, created_at FROM ops_audit ORDER BY created_at DESC, id DESC LIMIT $1",
      [Math.min(Number(q.limit) || 200, 1000)],
    );
  });
}
