import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWebhook, verifySignature } from "../src/whatsapp/webhook.js";

const ids = { customer: "PNID_CUSTOMER", business: "PNID_BUSINESS" };

function payload(phoneNumberId: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
  };
}

describe("verifySignature", () => {
  const body = JSON.stringify({ hello: "world" });
  const secret = "app-secret";
  const good = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  it("accepts Meta's signature", () => {
    expect(verifySignature(body, good, secret)).toBe(true);
  });

  it("rejects a wrong, missing or malformed signature", () => {
    expect(verifySignature(body, good, "other-secret")).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifySignature(body + " ", good, secret)).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("parses a text message with the sender's name and channel", () => {
    const out = parseWebhook(
      payload(ids.customer, {
        contacts: [{ profile: { name: "Tendai" }, wa_id: "263771234567" }],
        messages: [{ from: "263771234567", id: "wamid.1", timestamp: "1767225600", type: "text", text: { body: "I need a plumber" } }],
      }),
      ids,
    );
    expect(out.messages).toHaveLength(1);
    const m = out.messages[0]!;
    expect(m.channel).toBe("customer");
    expect(m.from).toBe("263771234567");
    expect(m.phone).toBe("263771234567");
    expect(m.profileName).toBe("Tendai");
    expect(m.timestamp.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(m.content).toEqual({ type: "text", text: "I need a plumber" });
  });

  it("parses buttons, list rows, template quick replies and locations", () => {
    const out = parseWebhook(
      payload(ids.business, {
        messages: [
          { from: "263770000001", id: "a", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "bsum", title: "My summary" } } },
          { from: "263770000001", id: "b", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "biz:1:2", title: "Shop", description: "Avondale" } } },
          { from: "263770000001", id: "c", type: "button", button: { payload: "aa:x:yes", text: "Yes, I can help" } },
          { from: "263770000001", id: "d", type: "location", location: { latitude: -17.8, longitude: 31.05, name: "Home" } },
          { from: "263770000001", id: "e", type: "sticker", sticker: {} },
        ],
      }),
      ids,
    );
    expect(out.messages.map((m) => m.channel)).toEqual(Array(5).fill("business"));
    expect(out.messages.map((m) => m.content)).toEqual([
      { type: "button_reply", id: "bsum", title: "My summary" },
      { type: "list_reply", id: "biz:1:2", title: "Shop", description: "Avondale" },
      { type: "button_reply", id: "aa:x:yes", title: "Yes, I can help" },
      { type: "location", lat: -17.8, lng: 31.05, name: "Home", address: undefined },
      { type: "unsupported", rawType: "sticker" },
    ]);
  });

  it("reads delivery statuses and ignores numbers we don't own", () => {
    const statuses = parseWebhook(payload(ids.customer, { statuses: [{ id: "wamid.9", status: "read", recipient_id: "263771234567" }] }), ids);
    expect(statuses.statuses).toEqual([{ channel: "customer", waMessageId: "wamid.9", status: "read", recipient: "263771234567", errors: undefined }]);
    const foreign = parseWebhook(payload("SOMEONE_ELSE", { messages: [{ from: "1", id: "x", type: "text", text: { body: "hi" } }] }), ids);
    expect(foreign.messages).toHaveLength(0);
    expect(parseWebhook({ object: "page" }, ids).messages).toHaveLength(0);
  });

  it("accepts senders without a phone number (business-scoped user IDs)", () => {
    const out = parseWebhook(payload(ids.customer, { messages: [{ from_user_id: "ZW.abc123", id: "u1", type: "text", text: { body: "hi" } }] }), ids);
    expect(out.messages[0]?.from).toBe("ZW.abc123");
    expect(out.messages[0]?.phone).toBeUndefined();
  });
});
