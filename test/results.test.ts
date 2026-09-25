import { describe, expect, it } from "vitest";
import * as copy from "../src/conversation/copy.js";
import type { BusinessView, Need } from "../src/conversation/copy.js";
import type { OutboundMessage } from "../src/whatsapp/outbound.js";

const business = (name: string, verified: boolean): BusinessView => ({
  id: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  description: "",
  verification: verified ? "verified" : "registered",
  areaName: "Avondale",
  distanceKm: 1.2,
  ratingAvg: null,
  ratingCount: 0,
});

const tv: Need = { kind: "goods", text: "samsung tv" };
const plumbing: Need = { kind: "service", text: "plumbing services" };

const body = (m: OutboundMessage) => (m.kind === "list" ? m.body : m.kind === "location_request" ? m.body : m.kind === "text" ? m.text : "");
const sections = (m: OutboundMessage) => (m.kind === "list" ? m.sections.map((s) => [s.title, s.rows.map((r) => r.title)]) : []);

describe("results say which businesses our team verified", () => {
  it("tells customers the verified stores have what they asked for", () => {
    const m = copy.results("r1", [business("TechZone", true), business("Mobile Hub", true)], tv, "Avondale");
    expect(body(m)).toBe("We have two stores near Avondale that our team has verified, and they have *samsung tv*. Tap one to connect with them.");
    expect(m.kind === "list" && m.button).toBe("See stores");
    expect(sections(m)).toEqual([
      ["Verified by our team", ["TechZone", "Mobile Hub"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
  });

  it("says what service businesses offer, never 'businesses for plumber'", () => {
    const one = copy.results("r1", [business("QuickFix Plumbing", true)], plumbing, "Mabelreign");
    expect(body(one)).toBe("We have a business near Mabelreign that offers *plumbing services*, and our team has verified it. Tap it to connect with them.");
    expect(one.kind === "list" && one.button).toBe("See businesses");
    const legal: Need = { kind: "service", text: "legal services" };
    expect(body(copy.results("r1", [business("Lex & Co", true), business("Moyo Legal", true)], legal))).toBe(
      "We have two businesses that offer *legal services*, and our team has verified them. Tap one to connect with them.",
    );
    const drone: Need = { kind: "other", text: "drone" };
    expect(body(copy.results("r1", [business("SkyShop", true)], drone, "Avondale"))).toBe(
      "We have a business near Avondale that can help with *drone*, and our team has verified it. Tap it to connect with them.",
    );
  });

  it("counts businesses that listed themselves apart, with a warning", () => {
    const m = copy.results("r1", [business("QuickFix Plumbing", true), business("Hatfield Plumbing", true), business("Waterfalls Plumbers", false)], plumbing, "Mabelreign");
    expect(body(m)).toBe(
      "We have two businesses near Mabelreign that offer *plumbing services*, and our team has verified them. " +
        "One more listed itself and hasn't been checked by our team yet. Tap one to connect with them.\n\n" +
        "⚠️ Don't pay a deposit before you see the item or the work.",
    );
    expect(sections(m)).toEqual([
      ["Verified by our team", ["QuickFix Plumbing", "Hatfield Plumbing"]],
      ["Not checked yet", ["Waterfalls Plumbers"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
  });

  it("never calls a business verified when none is", () => {
    const store = copy.results("r1", [business("Gadget City", false)], tv, "Avondale");
    expect(body(store)).toBe(
      "We don't have a verified store near Avondale with *samsung tv* yet. This one listed itself and hasn't been checked by our team. " +
        "Tap it to connect with them.\n\n⚠️ Don't pay a deposit before you see the item or the work.",
    );
    expect(sections(store)).toEqual([
      ["Not checked yet", ["Gadget City"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
    const plumbers = copy.results("r1", [business("Waterfalls Plumbers", false), business("Budiriro Plumbers", false)], plumbing, "Mabelreign");
    expect(body(plumbers)).toMatch(/^We don't have a verified business near Mabelreign that offers \*plumbing services\* yet\. These two listed themselves/);
  });

  it("words the other replies about a request the same way", () => {
    expect(body(copy.askLocation(plumbing))).toBe("Where should I look for *plumbing services*? Share your location, or type your suburb or town.");
    expect(body(copy.relatedResults("r1", [business("Avondale Electronics", true)], { kind: "goods", text: "ps5 controller" }, "electronics shops", "Avondale"))).toMatch(
      /^We don't have a store near Avondale with \*ps5 controller\* yet, but these electronics shops may have it or know where to get it\./,
    );
    expect(body(copy.noSupplierHandoff({ kind: "service", text: "legal services" }, "Avondale", "We'll reply soon."))).toMatch(
      /^We don't have a business near Avondale that offers \*legal services\* on our list yet, so I've passed your request to our team/,
    );
  });

  it("tells new customers why they can trust verified businesses", () => {
    const m = copy.consent("Directory ZW", undefined, "Tendai Moyo");
    expect(m.kind === "buttons" && m.body).toContain(
      "✅ Every business we verify is visited in person by our team, and we check who runs it, so you know it's genuine and reliable.",
    );
  });
});
