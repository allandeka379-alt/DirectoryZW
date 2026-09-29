import type { FastifyInstance } from "fastify";
import { upsertContact } from "../src/conversation/store.js";
import { createOwnerSession } from "../src/web/owner-auth.js";
import type { InboundContent, InboundMessage } from "../src/whatsapp/types.js";
import { textOf, type TestApp } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
export const photo = () => ({ contentType: "image/jpeg", dataBase64: JPEG.toString("base64") });

export interface NewProduct {
  name: string;
  price?: number | null;
  category?: string;
  description?: string;
  unit?: string;
}

/** The owner of a sample business, signed in to the dashboard, calling its API for that business. */
export async function dashboardOf(app: TestApp, server: FastifyInstance, businessName: string) {
  const [b] = await app.db.query<{ id: string; phone: string }>("SELECT id, phone FROM businesses WHERE name = $1", [businessName]);
  if (!b) throw new Error(`No business named ${businessName}`);
  const contact = await upsertContact(app.db, { channel: "business", waId: b.phone, phone: b.phone, at: app.clock.now });
  await app.db.query("UPDATE businesses SET owner_contact_id = $2 WHERE id = $1", [b.id, contact.id]);
  const cookie = `dz_owner=${await createOwnerSession(app.db, contact.id, app.clock.now)}`;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    server.inject({ method, url: `/app/api/businesses/${b.id}${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async (res: Awaited<ReturnType<typeof call>>) => {
    if (res.statusCode >= 300) throw new Error(`Dashboard said ${res.statusCode}: ${res.body}`);
    return res.json();
  };
  return {
    id: b.id,
    call,
    /** Lists a product; its ID. */
    add: async (p: NewProduct): Promise<string> => (await ok(await call("POST", "/products", p))).id,
    change: async (productId: string, patch: object) => ok(await call("PUT", `/products/${productId}`, patch)),
    /** Gives a product a photo; the photo's ID. */
    photo: async (productId: string): Promise<string> => (await ok(await call("PUT", `/products/${productId}/photo`, photo()))).photoId,
    stock: async (ids: string[], inStock: boolean) => ok(await call("POST", "/products/stock", { ids, inStock })),
    archive: async (ids: string[]) => ok(await call("POST", "/products/archive", { ids })),
  };
}

let n = 0;

/** A new customer writing to us, already agreed to our terms once `agree()` is done. */
export function newCustomer(app: TestApp, name = "Chipo Dube") {
  const number = `26377444${String(++n).padStart(4, "0")}`;
  let seq = 0;
  const send = (content: InboundContent, extra: Partial<InboundMessage> = {}) =>
    app.engine.enqueue({
      channel: "customer",
      waMessageId: `c-${number}-${++seq}`,
      from: number,
      phone: number,
      profileName: name,
      timestamp: app.clock.now,
      content,
      ...extra,
    });
  return {
    number,
    send,
    say: (text: string) => send({ type: "text", text }),
    tap: (title: string) => app.tap(title, "customer", number),
    last: () => app.last("customer", number),
    all: () => app.outbox("customer", number).map((m) => m.message),
    texts: () => app.outbox("customer", number).map((m) => textOf(m.message)),
    agree: async () => {
      await send({ type: "text", text: "hi" });
      await app.tap("I agree", "customer", number);
    },
  };
}
