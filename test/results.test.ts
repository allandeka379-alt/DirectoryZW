import { describe, expect, it } from "vitest";
import * as copy from "../src/conversation/copy.js";
import type { BusinessView } from "../src/conversation/copy.js";
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

const body = (m: OutboundMessage) => (m.kind === "list" ? m.body : "");
const sections = (m: OutboundMessage) => (m.kind === "list" ? m.sections.map((s) => [s.title, s.rows.map((r) => r.title)]) : []);

describe("results say which businesses our team verified", () => {
  it("tells customers the verified stores have what they asked for", () => {
    const m = copy.results("r1", [business("TechZone", true), business("Mobile Hub", true)], "iphone 18 pro max", "Avondale", true);
    expect(body(m)).toBe(
      "We have 2 stores near Avondale that our team has verified, and they have *iphone 18 pro max*. Tap one to connect with them.",
    );
    expect(m.kind === "list" && m.button).toBe("See stores");
    expect(sections(m)).toEqual([
      ["Verified by our team", ["TechZone", "Mobile Hub"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
  });

  it("names services as businesses for what they need", () => {
    const one = copy.results("r1", [business("QuickFix Plumbing", true)], "plumber", "Mabelreign");
    expect(body(one)).toBe("We have a business for *plumber* near Mabelreign, and our team has verified it. Tap it to connect with them.");
    expect(one.kind === "list" && one.button).toBe("See businesses");
    const noPlace = copy.results("r1", [business("Lex & Co", true), business("Moyo Legal", true)], "lawyer");
    expect(body(noPlace)).toBe("We have 2 businesses for *lawyer*, and our team has verified them. Tap one to connect with them.");
  });

  it("counts businesses that listed themselves apart, with a warning", () => {
    const m = copy.results("r1", [business("TechZone", true), business("Gadget City", false), business("Phone Point", false)], "iphone 18 pro max", "Avondale", true);
    expect(body(m)).toBe(
      "We have a store near Avondale that our team has verified, and it has *iphone 18 pro max*. " +
        "2 more listed themselves and haven't been checked by our team yet. Tap one to connect with them.\n\n" +
        "⚠️ Don't pay a deposit before you see the item or the work.",
    );
    expect(sections(m)).toEqual([
      ["Verified by our team", ["TechZone"]],
      ["Not checked yet", ["Gadget City", "Phone Point"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
  });

  it("never calls a business verified when none is", () => {
    const m = copy.results("r1", [business("Gadget City", false)], "iphone 18 pro max", "Avondale", true);
    expect(body(m)).toBe(
      "We don't have a verified store for *iphone 18 pro max* near Avondale yet. This one listed itself and hasn't been checked by our team. " +
        "Tap it to connect with them.\n\n⚠️ Don't pay a deposit before you see the item or the work.",
    );
    expect(sections(m)).toEqual([
      ["Not checked yet", ["Gadget City"]],
      ["Not right?", ["Not what I asked for"]],
    ]);
  });
});
