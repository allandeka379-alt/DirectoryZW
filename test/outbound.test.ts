import { describe, expect, it } from "vitest";
import { normalize, toCloudPayload, type OutboundMessage } from "../src/whatsapp/outbound.js";

describe("normalize", () => {
  it("keeps buttons within WhatsApp's limits", () => {
    const m = normalize({
      kind: "buttons",
      body: "x".repeat(2000),
      buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `A very long button title ${i}` })),
    });
    if (m.kind !== "buttons") throw new Error("kind");
    expect(m.body.length).toBe(1024);
    expect(m.buttons).toHaveLength(3);
    expect(m.buttons.every((b) => b.title.length <= 20)).toBe(true);
  });

  it("caps list rows at 10 across sections and trims titles and descriptions", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Business number ${i} with a long name`, description: "d".repeat(100) }));
    const m = normalize({ kind: "list", body: "Pick", button: "See all the options please", sections: [{ title: "First", rows: rows(7) }, { rows: rows(7) }] });
    if (m.kind !== "list") throw new Error("kind");
    expect(m.sections.flatMap((s) => s.rows)).toHaveLength(10);
    expect(m.sections[1]!.rows).toHaveLength(3);
    expect(m.button.length).toBeLessThanOrEqual(20);
    for (const r of m.sections.flatMap((s) => s.rows)) {
      expect(r.title.length).toBeLessThanOrEqual(24);
      expect(r.description!.length).toBeLessThanOrEqual(72);
    }
  });
});

describe("toCloudPayload", () => {
  it("builds reply-button messages", () => {
    const p = toCloudPayload("263771234567", { kind: "buttons", body: "Hi", buttons: [{ id: "yes", title: "Yes" }] });
    expect(p).toMatchObject({
      messaging_product: "whatsapp",
      to: "263771234567",
      type: "interactive",
      interactive: { type: "button", body: { text: "Hi" }, action: { buttons: [{ type: "reply", reply: { id: "yes", title: "Yes" } }] } },
    });
  });

  it("builds list, link, location-request and contact messages", () => {
    const list = toCloudPayload("1", { kind: "list", body: "b", button: "See", sections: [{ title: "S", rows: [{ id: "r", title: "T" }] }] });
    expect(list).toMatchObject({ interactive: { type: "list", action: { button: "See", sections: [{ title: "S", rows: [{ id: "r", title: "T" }] }] } } });
    const cta = toCloudPayload("1", { kind: "cta_url", body: "b", displayText: "Open", url: "https://wa.me/2637" });
    expect(cta).toMatchObject({ interactive: { type: "cta_url", action: { name: "cta_url", parameters: { display_text: "Open", url: "https://wa.me/2637" } } } });
    const loc = toCloudPayload("1", { kind: "location_request", body: "Where?" });
    expect(loc).toMatchObject({ interactive: { type: "location_request_message", action: { name: "send_location" } } });
    const card = toCloudPayload("1", { kind: "contact_card", name: "Shop", phone: "263771234567" });
    expect(card).toMatchObject({ type: "contacts", contacts: [{ phones: [{ phone: "+263771234567", wa_id: "263771234567" }] }] });
  });

  it("builds templates with body parameters and quick-reply payloads", () => {
    const fallback: OutboundMessage = { kind: "text", text: "fallback" };
    const p = toCloudPayload("1", {
      kind: "template",
      name: "follow_up",
      language: "en",
      bodyParams: ["Shop\nName"],
      quickReplies: [{ id: "fb:1:sorted", title: "Yes" }, { id: "fb:1:no_reply", title: "No" }],
      fallback,
    });
    expect(p).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1",
      type: "template",
      template: {
        name: "follow_up",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Shop · Name" }] },
          { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "fb:1:sorted" }] },
          { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "fb:1:no_reply" }] },
        ],
      },
    });
  });
});
