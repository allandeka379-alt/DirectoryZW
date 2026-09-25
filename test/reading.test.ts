import { beforeAll, describe, expect, it } from "vitest";
import { KeywordInterpreter } from "../src/ai/keyword-interpreter.js";
import { Lexicon } from "../src/ai/lexicon.js";
import { analyzeLocally } from "../src/ai/local.js";
import { signatureOf } from "../src/ai/reading.js";
import { findRoot, withoutJoiner } from "../src/ai/shona.js";
import type { InterpretContext } from "../src/ai/types.js";
import { openDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { seedReferenceData } from "../src/db/seed.js";
import { Gazetteer } from "../src/directory/gazetteer.js";
import { Taxonomy } from "../src/directory/taxonomy.js";
import { normalizeMessage } from "../src/text.js";

let ctx: InterpretContext;
/** As if a native speaker had approved the draft Shona words. */
let reviewed: InterpretContext;
const k = new KeywordInterpreter();
const read = (text: string) => k.read(text, ctx);
const analyze = (text: string, c = ctx) => analyzeLocally(text, c, k);

beforeAll(async () => {
  const db = await openDb({});
  await migrate(db);
  await seedReferenceData(db);
  const taxonomy = await Taxonomy.load(db);
  const gazetteer = await Gazetteer.load(db);
  ctx = { taxonomy, gazetteer, lexicon: await Lexicon.load(db, taxonomy) };
  reviewed = { ...ctx, lexicon: await Lexicon.load(db, taxonomy, { trustDrafts: true }) };
  await db.close();
});

describe("Shona word shapes", () => {
  const roots = ["gadzir", "tsvag", "teng", "roj", "vak", "bik", "tam", "wach"].sort((a, b) => b.length - a.length);

  it("finds verb roots inside inflected words", () => {
    expect(findRoot("anogadzira", roots)?.root).toBe("gadzir");
    expect(findRoot("kugadzirisa", roots)?.root).toBe("gadzir");
    expect(findRoot("mugadziri", roots)?.root).toBe("gadzir");
    expect(findRoot("ndigadzirirewo", roots)?.root).toBe("gadzir");
    expect(findRoot("yekuroja", roots)?.root).toBe("roj");
    expect(findRoot("vanotengesa", roots)?.root).toBe("teng");
    expect(findRoot("ndirikutsvaga", roots)?.root).toBe("tsvag");
    expect(findRoot("vakavaka", roots)?.root).toBe("vak");
  });

  it("doesn't see short roots in words that only contain them", () => {
    expect(findRoot("wachi", roots)).toBeUndefined(); // a watch, not "wash"
    expect(findRoot("tama", roots)).toBeUndefined(); // needs a prefix
    expect(findRoot("bike", roots)).toBeUndefined();
    expect(findRoot("vakadzi", roots)).toBeUndefined(); // women
  });

  it("strips joining prefixes, and knows which ones make a word describe another", () => {
    expect(withoutJoiner("remuchato")).toContainEqual({ stem: "muchato", describes: true });
    expect(withoutJoiner("nemacheya")).toContainEqual({ stem: "macheya", describes: false });
  });
});

describe("reading a request", () => {
  it("applies actions to the things they're about", () => {
    expect(read("ndirikutsvaga munhu anogadzira fridge ku Glen View").candidates).toEqual(["appliance_repair"]);
    expect(read("Who fixes cracked phone screens in Eastlea?").candidates).toEqual(["electronics_repair"]);
    expect(read("someone to paint my house in Westgate").candidates).toEqual(["painting"]);
    expect(read("Truck to move my furniture to Bulawayo next week").candidates).toEqual(["transport_moving"]);
    expect(read("Ndoda matende nemacheya ekuroja ku Budiriro").candidates).toEqual(["event_hire"]);
    expect(read("honda fit for sale").candidates).toEqual(["car_sales"]);
    expect(read("I want to rent a car in Bulawayo").candidates).toEqual(["car_hire"]);
    expect(read("sofa cleaning in Greendale").candidates).toEqual(["cleaning"]);
    expect(read("ndoda kudzidza kutyaira").candidates).toEqual(["driving_school"]);
  });

  it("lets brands, occasions and general words narrow, not decide", () => {
    expect(read("tyres for a Toyota Corolla in Kuwadzana").candidates).toEqual(["car_parts"]);
    expect(read("mechanic for honda fit gearbox Arcadia").candidates).toEqual(["car_repairs"]);
    expect(read("bhatiri remota").candidates).toEqual(["car_parts"]);
    expect(read("ndoda nyama yemombe ku Mbare").candidates).toEqual(["butchery"]); // meat of cattle, not cattle
    expect(read("ndoda tangi remvura").candidates).toEqual(["water_delivery"]);
    expect(read("catering for a funeral in Highfield").candidates).toEqual(["catering"]);
    expect(read("toyota")).toMatchObject({ decidedBy: "context", candidates: ["car_sales", "car_parts", "car_repairs"] });
  });

  it("keeps words with two meanings open", () => {
    expect(read("paint").candidates.sort()).toEqual(["hardware", "painting"]);
    expect(read("100 chairs and a tent").candidates).toEqual(["event_hire"]);
    expect(read("fix my shoes").unusedActions).toEqual(["fix"]);
  });

  it("reads places with prefixes and typos, and texting spellings", () => {
    expect(read("ndoda plumber kuMabelreign").area?.name).toBe("Mabelreign");
    expect(read("plumber eNkulumane").area?.name).toBe("Nkulumane");
    const typo = read("plumbar in Mabelrein");
    expect(typo).toMatchObject({ candidates: ["plumbing"], unknown: [] });
    expect(typo.area?.name).toBe("Mabelreign");
    expect(typo.doubts[0]).toContain("plumbar");
    const two = read("ndinoda solar installer ku Hillside Bulawayo");
    expect(two.unknown).toEqual([]);
    expect(two.area?.name).toBe("Hillside");
    expect(normalizeMessage("Pls i need a 55inch tv 2moro!!")).toBe("please i need a 55 inch tv tomorrow");
    expect(read("clocks").candidates).toEqual([]); // not "blocks"
  });

  it("blocks what can't be searched, in Shona too", () => {
    expect(read("ndinoda doro").blocked).toBe("blocked_alcohol");
    expect(read("ndoda chikwereti").blocked).toBe("blocked_lending");
  });

  it("keys the phrasebook by dictionary forms", () => {
    expect(signatureOf(read("ndoda keke remuchato ku Budiriro"))).toBe("keke muchato");
    expect(signatureOf(read("Ndoda matende nemacheya ekuroja"))).toBe("macheya matende roj");
    expect(signatureOf(read("ma tyres e Honda Fit"))).toBe("honda_fit tyres");
  });
});

describe("how sure the engine is", () => {
  it("answers approved words straight away and asks about draft ones", async () => {
    expect((await analyze("someone to paint my house in Westgate")).band).toBe("high");
    // "mota" (a car) is a draft word: it narrows "battery" to car parts, so the answer isn't certain yet.
    expect(await analyze("battery for my mota")).toMatchObject({ band: "medium", options: ["car_parts"] });
    expect((await analyze("battery for my car")).band).toBe("high");
    const draft = await analyze("ndoda keke remuchato");
    expect(draft).toMatchObject({ band: "medium", options: ["cakes"] });
    expect(draft.reasons.join(" ")).toContain("draft word");
    expect((await analyze("ndoda keke remuchato", reviewed)).band).toBe("high");
    expect((await analyze("ndirikutsvaga munhu anogadzira fridge ku Glen View", reviewed)).band).toBe("high");
  });

  it("asks when several categories fit, a spelling was guessed or an action doesn't fit", async () => {
    expect(await analyze("paint")).toMatchObject({ band: "medium", options: ["hardware", "painting"] });
    expect((await analyze("plumbar in Mabelrein")).band).toBe("medium");
    expect((await analyze("fix my shoes")).band).toBe("medium");
    expect((await analyze("toyota")).band).toBe("medium");
  });

  it("leaves mostly unknown wording to Claude or a person", async () => {
    expect((await analyze("ndoda zvinotapira zvemuchato")).band).toBe("low");
    expect((await analyze("the heel came off")).band).toBe("low");
  });

  it("classifies business descriptions in Shona", async () => {
    expect((await k.classifyBusiness("Tinogadzira mafiriji nezvitofu", ctx)).category_slugs[0]).toBe("appliance_repair");
    const both = await k.classifyBusiness("We sell phones and fix laptops", ctx);
    expect(both.category_slugs).toEqual(expect.arrayContaining(["electronics_repair", "phones"]));
    expect((await k.classifyBusiness("We restore antique clocks", ctx)).category_slugs).toEqual([]);
  });
});
