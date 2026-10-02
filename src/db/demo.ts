import { randomUUID } from "node:crypto";
import type { Db } from "./client.js";

/**
 * Sample activity for trying the dashboards on a local database: months of customers asking for
 * things across Harare (and a little of Bulawayo and other towns), the sample businesses that came up,
 * the ones customers chose and how they answered our follow-up, products and price changes, website
 * sign-ups and owners visiting their dashboard. All of it is fictional and marked, so it can be
 * removed: sample businesses and contacts use numbers starting 2637999, which no network hands out.
 *
 * Never for production: `npm run db:demo` refuses unless the database is the local one.
 */

export const DEMO_PREFIX = "2637999";
const DAY = 24 * 3600_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A small, repeatable random number generator (mulberry32), so the same seed gives the same data. */
function generator(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + (hi - lo) * next();
  const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
  const chance = (p: number) => next() < p;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  function weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let x = next() * total;
    for (const [item, w] of items) if ((x -= w) <= 0) return item;
    return items[items.length - 1]![0];
  }
  return { next, between, int, chance, pick, weighted };
}

type Product = readonly [name: string, price: number, unit?: string];

interface Line {
  slug: string;
  /** How often people ask for it, relative to the others. */
  weight: number;
  /** How many sample businesses list it (a low number makes a supply gap). */
  supply: number;
  /** Words for the business names. */
  names: readonly string[];
  /** What people type, for services; goods use their product names too. */
  asks: readonly string[];
  products?: readonly Product[];
  /** Demand that grows over the months (solar). */
  growing?: boolean;
}

const LINES: readonly Line[] = [
  {
    slug: "appliances",
    weight: 9,
    supply: 8,
    names: ["Appliances", "Home Store", "Home & Kitchen"],
    asks: ["fridge", "fridges", "home appliances"],
    products: [["Double door fridge", 589], ["Single door fridge", 320], ["Chest freezer 300L", 420], ["Washing machine 7kg", 380], ["4 plate stove", 290], ["Microwave 20L", 95], ["Kettle", 18], ["Air fryer", 75], ["Water dispenser", 120]],
  },
  {
    slug: "phones",
    weight: 8,
    supply: 7,
    names: ["Mobile", "Cellular", "Gadgets"],
    asks: ["phone", "smartphone", "cheap phone"],
    products: [["Samsung A15", 150], ["iPhone 13", 420], ["Tecno Spark 20", 115], ["Itel A70", 75], ["Redmi Note 13", 190], ["Power bank 20000mAh", 25], ["Phone charger", 8]],
  },
  {
    slug: "solar",
    weight: 8,
    supply: 4,
    growing: true,
    names: ["Solar", "Solar & Power", "Energy"],
    asks: ["solar installation", "solar system for my house", "solar installer"],
    products: [["5kVA inverter", 650], ["3kVA inverter", 420], ["200Ah lithium battery", 980], ["100Ah lithium battery", 520], ["550W solar panel", 135], ["Solar geyser 200L", 650], ["Solar lights", 25]],
  },
  {
    slug: "hardware",
    weight: 8,
    supply: 9,
    names: ["Hardware", "Hardware & Paint", "Building Supplies"],
    asks: ["hardware shop", "plumbing fittings"],
    products: [["Cement 50kg", 11.5, "per bag"], ["PVC pipe 4 inch", 14], ["Door lock", 18], ["Paint 20 litres", 55], ["IBR roofing sheet", 13], ["Wheelbarrow", 45], ["Floor tiles", 9, "per metre"], ["Steel rebar 12mm", 9]],
  },
  {
    slug: "building_materials",
    weight: 5,
    supply: 4,
    names: ["Building Materials", "Brick & Sand", "Builders Supplies"],
    asks: ["building materials", "bricks", "river sand"],
    products: [["Common bricks", 95, "per 1000"], ["River sand", 120, "per load"], ["Quarry stone", 150, "per load"], ["Roof trusses", 25]],
  },
  {
    slug: "car_parts",
    weight: 6,
    supply: 5,
    names: ["Auto Spares", "Motor Spares", "Tyres & Parts"],
    asks: ["car parts", "spares for honda fit", "toyota spares"],
    products: [["Tyre 195/65 R15", 75], ["Car battery", 95], ["Brake pads", 28], ["Engine oil 5L", 32], ["Oil filter", 8]],
  },
  { slug: "car_repairs", weight: 5, supply: 4, names: ["Motors", "Auto Repairs", "Garage"], asks: ["mechanic", "car service", "gearbox repair", "panel beater"] },
  { slug: "plumbing", weight: 5, supply: 3, names: ["Plumbing", "Plumbers"], asks: ["plumber", "blocked drain", "geyser repair", "burst pipe"] },
  { slug: "electrical", weight: 5, supply: 4, names: ["Electrical Services", "Electricians"], asks: ["electrician", "house wiring", "db board repair"] },
  {
    slug: "gas_lpg",
    weight: 5,
    supply: 4,
    names: ["Gas", "LPG Gas"],
    asks: ["gas refill", "gas near me"],
    products: [["Gas refill 9kg", 18], ["Gas refill 19kg", 38], ["Gas refill 48kg", 95], ["Gas cylinder 9kg", 45], ["2 plate gas stove", 35]],
  },
  {
    slug: "tv_audio",
    weight: 4,
    supply: 3,
    names: ["TV & Sound", "Electronics"],
    asks: ["tv", "smart tv"],
    products: [["43 inch smart TV", 260], ["55 inch smart TV", 420], ["32 inch TV", 150], ["Soundbar", 110], ["Bluetooth speaker", 45]],
  },
  {
    slug: "computers",
    weight: 4,
    supply: 3,
    names: ["Computers", "Tech"],
    asks: ["laptop", "computer shop"],
    products: [["Laptop Core i5 8GB", 420], ["Laptop Core i3", 300], ["Printer", 160], ["Laptop charger", 25], ["Flash drive 64GB", 9]],
  },
  {
    slug: "furniture",
    weight: 4,
    supply: 4,
    names: ["Furniture", "Furnishers"],
    asks: ["furniture", "sofa"],
    products: [["3 piece lounge suite", 750], ["Double bed with mattress", 380], ["6 seater dining set", 520], ["Office chair", 85], ["Wardrobe", 260], ["TV stand", 90]],
  },
  {
    slug: "clothing",
    weight: 3,
    supply: 3,
    names: ["Boutique", "Fashions", "Clothing"],
    asks: ["school uniforms", "clothes shop"],
    products: [["School uniform", 35], ["Men's suit", 110], ["Sneakers", 45], ["Work boots", 38]],
  },
  {
    slug: "pharmacy",
    weight: 4,
    supply: 3,
    names: ["Pharmacy", "Chemists"],
    asks: ["pharmacy", "pharmacy open now"],
    products: [["Blood pressure monitor", 35], ["Baby formula", 12], ["Glucometer", 28], ["Paracetamol", 2]],
  },
  {
    slug: "groceries",
    weight: 3,
    supply: 3,
    names: ["Supermarket", "Grocers"],
    asks: ["groceries", "wholesale groceries"],
    products: [["Mealie meal 10kg", 6.5], ["Cooking oil 2L", 4.2], ["Rice 10kg", 12], ["Sugar 2kg", 2.4]],
  },
  { slug: "butchery", weight: 2, supply: 2, names: ["Butchery", "Meats"], asks: ["butchery", "meat"], products: [["Beef", 7, "per kg"], ["Whole chicken", 6.5], ["T-bone steak", 9, "per kg"]] },
  { slug: "salons", weight: 3, supply: 3, names: ["Hair Studio", "Salon", "Barbers"], asks: ["braids", "barber", "nails", "hair salon"] },
  { slug: "electronics_repair", weight: 3, supply: 2, names: ["Phone Repairs", "Repairs"], asks: ["phone screen repair", "laptop repair", "phone repair"] },
  { slug: "appliance_repair", weight: 2, supply: 2, names: ["Fridge & Appliance Repairs"], asks: ["fridge repair", "washing machine repair"] },
  { slug: "cakes", weight: 2, supply: 2, names: ["Cakes", "Bakery"], asks: ["birthday cake", "wedding cake"] },
  { slug: "catering", weight: 1.5, supply: 1, names: ["Catering"], asks: ["catering for 100 people", "caterer"] },
  { slug: "printing", weight: 1.5, supply: 2, names: ["Printers", "Print & Branding"], asks: ["business cards", "banner printing", "t-shirt printing"] },
  { slug: "courier", weight: 2, supply: 2, names: ["Couriers", "Deliveries"], asks: ["courier to bulawayo", "delivery service"] },
  { slug: "borehole", weight: 2, supply: 1, names: ["Drilling"], asks: ["borehole drilling", "borehole pump"] },
  { slug: "water_delivery", weight: 1.5, supply: 1, names: ["Water Supplies"], asks: ["water delivery", "water tank 5000 litres"] },
  { slug: "generators", weight: 2, supply: 2, names: ["Generators", "Power"], asks: ["generator", "generator repair"], products: [["5kVA petrol generator", 480], ["2.5kVA generator", 260]] },
  { slug: "security", weight: 1.5, supply: 1, names: ["Security"], asks: ["security guards", "electric fence"] },
  { slug: "welding", weight: 1.5, supply: 1, names: ["Steel Works", "Welding"], asks: ["burglar bars", "gate welding"] },
  { slug: "transport_moving", weight: 1.5, supply: 1, names: ["Transport", "Movers"], asks: ["truck for moving", "lorry hire"] },
  { slug: "cleaning", weight: 1, supply: 1, names: ["Cleaning Services"], asks: ["house cleaning", "carpet cleaning"] },
  { slug: "tutoring", weight: 1, supply: 0, names: ["Tutors"], asks: ["maths tutor", "o level tutor"] },
  { slug: "event_hire", weight: 1, supply: 1, names: ["Events Hire"], asks: ["tent hire", "chairs hire"] },
  { slug: "photography", weight: 0.8, supply: 1, names: ["Studios", "Photography"], asks: ["wedding photographer"] },
  { slug: "painting", weight: 1, supply: 1, names: ["Painters"], asks: ["house painting", "painter"] },
  { slug: "carpentry", weight: 1, supply: 1, names: ["Carpentry", "Joinery"], asks: ["kitchen units", "carpenter"] },
  { slug: "car_hire", weight: 1, supply: 1, names: ["Car Hire"], asks: ["car hire", "car rental"] },
  { slug: "driving_school", weight: 0.8, supply: 0, names: ["Driving School"], asks: ["driving lessons", "driving school"] },
];

const SURNAMES = ["Moyo", "Ncube", "Dube", "Sibanda", "Chirwa", "Mutasa", "Banda", "Phiri", "Chikore", "Mhlanga", "Ndlovu", "Mapfumo", "Makoni", "Gumbo", "Nyathi", "Mpofu", "Tshuma", "Marufu", "Chiweshe", "Muchena", "Chinyama", "Mararike", "Shumba", "Nkomo", "Chari", "Mahachi", "Hove", "Kanengoni", "Mlambo", "Nyoni", "Sithole", "Tapfuma", "Zhou", "Matongo", "Chimedza", "Kativhu"];
const BRANDS = ["Prime", "Unity", "Sunrise", "Zambezi", "Kopje", "Jacaranda", "Chiedza", "Rufaro", "Tatenda", "Kuda", "Musasa", "Granite", "Eastgate", "Second Street", "Fife Avenue", "Copacabana"];

/** How people word a request, in English and in Shona. */
const PHRASES: readonly ((what: string, where: string | null) => string)[] = [
  (w, a) => (a ? `Looking for ${w} in ${a}` : `Looking for ${w}`),
  (w, a) => (a ? `Need ${w} near ${a}` : `Need ${w}`),
  (w, a) => (a ? `${w} ${a}` : w),
  (w) => `Where can I get ${w}?`,
  (w) => `${w} price`,
  (w, a) => (a ? `Ndiri kutsvaga ${w} ku${a}` : `Ndiri kutsvaga ${w}`),
  (w, a) => (a ? `Ndoda ${w} ku${a}` : `Ndoda ${w}`),
];

/** Where people ask from, and where businesses are, by area name. */
const BUSY_SUBURBS = new Set(["Mbare", "Highfield", "Glen View", "Budiriro", "Kuwadzana", "Dzivarasekwa", "Mufakose", "Warren Park", "Kambuzuma", "Epworth", "Hatcliffe", "Tafara", "Mabvuku", "Glen Norah", "Chitungwiza", "Sunningdale", "Westlea"]);
const SHOPPING = new Map([
  ["Harare CBD", 12],
  ["Avondale", 4],
  ["Borrowdale", 4],
  ["Msasa", 4],
  ["Southerton", 4],
  ["Workington", 3],
  ["Belvedere", 3],
  ["Eastlea", 3],
  ["Graniteside", 3],
  ["Mount Pleasant", 2],
  ["Bulawayo CBD", 4],
  ["Bulawayo", 3],
]);

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Insert many rows at once, a thousand per statement. */
async function insert(db: Db, table: string, columns: readonly (readonly [string, string])[], rows: Record<string, unknown>[]) {
  const names = columns.map(([n]) => n).join(", ");
  const types = columns.map(([n, t]) => `${n} ${t}`).join(", ");
  for (let i = 0; i < rows.length; i += 1000) {
    await db.query(`INSERT INTO ${table} (${names}) SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS x(${types})`, [JSON.stringify(rows.slice(i, i + 1000))]);
  }
}

export interface DemoSummary {
  businesses: number;
  products: number;
  customers: number;
  requests: number;
  connections: number;
  /** A sample business with an owner and plenty of activity, to open the business dashboard with. */
  showcase: { id: string; name: string; ownerContactId: string };
}

/** Remove everything a previous run added. */
export async function clearDemoActivity(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM web_registrations WHERE details->>'demo' = 'true'`);
    await tx.query(`DELETE FROM businesses WHERE is_sample AND phone LIKE '${DEMO_PREFIX}%'`);
    await tx.query(`DELETE FROM contacts WHERE wa_id LIKE '${DEMO_PREFIX}%'`);
  });
}

export async function seedDemoActivity(db: Db, now: Date, { days = 210, seed = 2026 } = {}): Promise<DemoSummary> {
  const rnd = generator(seed);
  const start = now.getTime() - days * DAY;
  const at = (t: number) => new Date(Math.min(t, now.getTime() - 60_000)).toISOString();

  const [areas, known] = await Promise.all([
    db.query<{ id: number; name: string; city: string; lat: number; lng: number }>("SELECT id, name, city, lat, lng FROM areas ORDER BY id"),
    db.query<{ slug: string; related: string[] }>("SELECT slug, related FROM categories"),
  ]);
  const lines = LINES.filter((l) => known.some((k) => k.slug === l.slug));
  const related = new Map(known.map((k) => [k.slug, k.related ?? []]));
  const suburb = (a: (typeof areas)[number]) => a.name !== a.city;

  // ----- Where customers ask from: mostly Harare's suburbs, some of Bulawayo, a few other towns.
  const askWeights = areas.map((a) => {
    if (a.city === "Harare") return [a, a.name === "Harare" ? 3 : a.name === "Harare CBD" ? 6 : BUSY_SUBURBS.has(a.name) ? 4 : 2] as const;
    if (a.city === "Bulawayo") return [a, a.name === "Bulawayo" ? 2 : 0.9] as const;
    return [a, 0.8] as const;
  });
  const shopWeights = areas.map((a) => [a, SHOPPING.get(a.name) ?? (a.city === "Harare" && suburb(a) ? 1 : a.city === "Bulawayo" ? 0.5 : 0.15)] as const);

  // ----- Businesses, their owners and their products.
  const usedNames = new Set<string>();
  const nameFor = (line: Line) => {
    for (;;) {
      const lead = rnd.chance(0.75) ? rnd.pick(SURNAMES) : rnd.pick(BRANDS);
      const name = `${lead} ${rnd.pick(line.names)} (sample)`;
      if (!usedNames.has(name)) return usedNames.add(name), name;
    }
  };
  let phone = 10000;
  const nextPhone = () => `${DEMO_PREFIX}${String(phone++).padStart(5, "0")}`;

  interface Biz {
    id: string;
    name: string;
    slug: string;
    area: (typeof areas)[number];
    lat: number;
    lng: number;
    verified: boolean;
    quality: number;
    created: number;
    owner: string | null;
    products: Map<string, { id: string; price: number }>;
    ratingSum: number;
    ratingCount: number;
  }
  const businesses: Biz[] = [];
  const contacts: Record<string, unknown>[] = [];
  const productRows: Record<string, unknown>[] = [];
  const priceChanges: Record<string, unknown>[] = [];
  const registrations: Record<string, unknown>[] = [];
  const sessions: Record<string, unknown>[] = [];

  for (const line of lines) {
    for (let i = 0; i < line.supply; i++) {
      const area = rnd.weighted(shopWeights);
      // Most were signed up in the first weeks; the rest joined steadily since.
      const created = rnd.chance(0.45) ? start + rnd.between(0, 35) * DAY : start + rnd.between(35, days - 1) * DAY;
      const ownerId = rnd.chance(0.65) ? randomUUID() : null;
      const biz: Biz = {
        id: randomUUID(),
        name: nameFor(line),
        slug: line.slug,
        area,
        lat: area.lat + rnd.between(-0.006, 0.006),
        lng: area.lng + rnd.between(-0.006, 0.006),
        verified: rnd.chance(0.68),
        quality: rnd.chance(0.08) ? rnd.between(0.25, 0.45) : rnd.between(0.6, 0.95),
        created,
        owner: ownerId,
        products: new Map(),
        ratingSum: 0,
        ratingCount: 0,
      };
      businesses.push(biz);
      if (ownerId) {
        const number = nextPhone();
        contacts.push({ id: ownerId, channel: "business", wa_id: number, phone: number, profile_name: biz.name.replace(" (sample)", ""), consent_at: at(created), last_inbound_at: at(created + rnd.between(0, now.getTime() - created)), created_at: at(created) });
        // Some owners open their dashboard often, some now and then, some never.
        const habit = rnd.weighted([[0, 3], [0.03, 4], [0.15, 3]] as const);
        for (let t = Math.max(created, now.getTime() - 120 * DAY); habit && t < now.getTime(); t += DAY) {
          if (rnd.chance(habit)) {
            sessions.push({ token_hash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), contact_id: ownerId, expires_at: at(t + 30 * DAY + DAY), created_at: at(t + rnd.between(7, 20) * 3600_000) });
          }
        }
      }
      // Products: most of the line's range, at the shop's own prices.
      for (const [productName, base, unit] of line.products ?? []) {
        if (!rnd.chance(0.75)) continue;
        const id = randomUUID();
        const price = Math.round(base * rnd.between(0.9, 1.15) * 100) / 100;
        const added = created + rnd.between(0, 20) * DAY;
        let current = price;
        let updated = added;
        // About a third have had their price changed since.
        for (let c = rnd.chance(0.35) ? rnd.int(1, 3) : 0; c > 0; c--) {
          const when = updated + rnd.between(5, 60) * DAY;
          if (when >= now.getTime()) break;
          const next = Math.round(current * rnd.between(0.9, 1.12) * 100) / 100;
          priceChanges.push({ offering_id: id, business_id: biz.id, old_price: current, new_price: next, reason: rnd.chance(0.8) ? "edit" : "bulk", created_at: at(when) });
          current = next;
          updated = when;
        }
        // Owners who keep their prices up to date confirm them every few weeks.
        if (rnd.chance(0.6)) updated = Math.max(updated, now.getTime() - rnd.between(1, 28) * DAY);
        productRows.push({
          id,
          business_id: biz.id,
          name: productName,
          price_usd: current,
          price_text: `$${current.toFixed(2)}`,
          unit: unit ?? "each",
          in_stock: rnd.chance(0.92),
          source: rnd.chance(0.7) ? "dashboard" : "import",
          price_updated_at: at(updated),
          created_at: at(added),
          updated_at: at(updated),
          catalog_dirty: false,
        });
        biz.products.set(productName.toLowerCase(), { id, price: current });
      }
      // Owners who signed up on the website went through a registration code.
      if (ownerId && rnd.chance(0.4)) {
        registrations.push({ code: `REG-${rnd.int(900000, 999999)}`, details: { demo: true, name: biz.name }, business_id: biz.id, expires_at: at(created + 60 * DAY), completed_at: at(created), created_at: at(created - rnd.between(0.1, 2) * DAY) });
      }
    }
  }
  // Website sign-ups that never sent their code.
  for (let i = 0; i < Math.round(days / 6); i++) {
    const t = start + rnd.between(0, days) * DAY;
    registrations.push({ code: `REG-${rnd.int(900000, 999999)}`, details: { demo: true, name: `${rnd.pick(SURNAMES)} ${rnd.pick(["Traders", "Enterprises", "Investments"])}` }, business_id: null, expires_at: at(t + 60 * DAY), completed_at: null, created_at: at(t) });
  }

  const byLine = new Map<string, Biz[]>();
  for (const b of businesses) byLine.set(b.slug, [...(byLine.get(b.slug) ?? []), b]);
  const lineOf = new Map(lines.map((l) => [l.slug, l]));

  // ----- Customers asking, day by day. Volume grows from the launch, dips on Sundays, peaks on weekdays
  // before work, at lunch and in the evening.
  const HOURS = [0.2, 0.1, 0.1, 0.1, 0.2, 0.6, 1.2, 2.4, 3.8, 4.4, 4, 3.6, 4, 4.2, 3.6, 3.2, 3.1, 3.4, 4.4, 5, 4.6, 3.2, 1.8, 0.8];
  const WEEKDAY = [0.7, 1, 1, 1, 1.05, 1.15, 1.2]; // Sunday first
  const customers: { id: string; home: (typeof areas)[number]; last: number }[] = [];
  const requests: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  const intros: Record<string, unknown>[] = [];
  const reports: Record<string, unknown>[] = [];
  const alerts: Record<string, unknown>[] = [];
  const usedRefs = new Set((await db.query<{ ref_code: string }>("SELECT ref_code FROM introductions")).map((r) => r.ref_code));
  const refCode = () => {
    for (;;) {
      const code = Array.from({ length: 5 }, () => rnd.pick(ALPHABET.split(""))).join("");
      if (!usedRefs.has(code)) return usedRefs.add(code), code;
    }
  };
  const owners = businesses.filter((b) => b.owner);
  // Days run from Harare midnight, so the hours people ask at are Harare hours.
  const first = new Date(start + 2 * 3600_000);
  const midnight = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()) - 2 * 3600_000;

  for (let d = 0; d <= days; d++) {
    const dayStart = midnight + d * DAY;
    const t = d / days;
    const weekday = new Date(dayStart + 2 * 3600_000).getUTCDay();
    const volume = Math.round((12 + 150 * (1 - Math.exp(-d / 60))) * WEEKDAY[weekday]! * rnd.between(0.85, 1.15));
    for (let n = 0; n < volume; n++) {
      const when = dayStart + (rnd.weighted(HOURS.map((w, h) => [h, w] as const)) + rnd.next()) * 3600_000;
      if (when >= now.getTime()) continue;
      // A business owner looking for supplies, now and then.
      const buyer = owners.length && rnd.chance(0.025) ? rnd.pick(owners.filter((o) => o.created < when)) : undefined;
      // Returning customers come back; new ones arrive.
      let customer: (typeof customers)[number] | undefined;
      // Most come back within a few weeks, so pick mostly among the recent ones.
      if (!buyer && customers.length && rnd.chance(0.45)) {
        customer = customers[Math.max(0, customers.length - 1 - Math.floor(rnd.next() ** 1.6 * Math.min(customers.length, 3500)))];
      }
      if (!buyer && !customer) {
        customer = { id: randomUUID(), home: rnd.weighted(askWeights), last: when };
        customers.push(customer);
        const number = nextPhone();
        contacts.push({ id: customer.id, channel: "customer", wa_id: number, phone: number, profile_name: null, consent_at: at(when), last_inbound_at: at(when), created_at: at(when), stopped_at: rnd.chance(0.015) ? at(when + rnd.between(1, 40) * DAY) : null });
      }
      const contactId = buyer ? buyer.owner! : customer!.id;
      if (customer) customer.last = when;
      const id = randomUUID();
      const intent = rnd.weighted([["search", 92], ["unclear", 3.5], ["human", 2], ["blocked", 1.5]] as const);
      const place = buyer ? buyer.area : rnd.chance(0.05) ? null : customer!.home;
      const areaLabel = place && place.name !== place.city && place.name !== "Harare CBD" ? place.name : place?.name === "Harare CBD" ? "town" : null;
      const base = { id, contact_id: contactId, area_id: place?.id ?? null, lat: place?.lat ?? null, lng: place?.lng ?? null, created_at: at(when), buyer_business_id: buyer?.id ?? null, product_matches: null as number | null };

      if (intent !== "search") {
        const text = intent === "unclear" ? rnd.pick(["mari yemazuva ano", "ndibatsireiwo", "the thing for the roof leak", "something for my mum"]) : intent === "human" ? "Can I talk to a person?" : rnd.pick(["forex", "loan today", "cheap cigarettes"]);
        requests.push({
          ...base,
          raw_text: text,
          interpretation: { intent, category_slug: null, query: "", area: null, budget_usd: null, needed_by: null, clarifying_question: null, language: "en" },
          category_slug: intent === "blocked" ? "blocked_forex" : null,
          query: "",
          status: intent === "unclear" ? (rnd.chance(0.5) ? "handoff" : "no_results") : "closed",
          match: intent === "blocked" ? null : "none",
          result_count: 0,
          understood_by: intent === "unclear" ? "fallback" : "local",
        });
        continue;
      }

      const line = rnd.weighted(lines.map((l) => [l, l.weight * (l.growing ? 0.5 + 1.1 * t : 1) * (buyer && !["groceries", "hardware", "building_materials"].includes(l.slug) ? 0.2 : 1)] as const));
      const product = line.products?.length && rnd.chance(0.72) ? rnd.pick(line.products) : null;
      const what = product ? product[0].toLowerCase() : rnd.pick(line.asks);
      // Shops in the same city, the ones listing the product first, then the nearest.
      const city = place?.city ?? "Harare";
      const from = place ?? areas.find((a) => a.name === "Harare")!;
      let match: "exact" | "related" | "none" = "exact";
      let pool = (byLine.get(line.slug) ?? []).filter((b) => b.created < when && b.area.city === city);
      if (!pool.length) {
        const near = (related.get(line.slug) ?? []).flatMap((s) => byLine.get(s) ?? []).filter((b) => b.created < when && b.area.city === city);
        if (near.length && rnd.chance(0.6)) {
          pool = near;
          match = "related";
        } else match = "none";
      }
      const productKey = product?.[0].toLowerCase();
      const ranked = pool
        .map((b) => ({ b, has: productKey ? b.products.get(productKey) : undefined, score: km(from, b) * (b.verified ? 0.75 : 1.25) * rnd.between(0.6, 1.4) }))
        .sort((x, y) => Number(Boolean(y.has)) - Number(Boolean(x.has)) || x.score - y.score)
        .slice(0, 3);
      const productMatches = productKey ? pool.filter((b) => b.products.has(productKey)).length : null;
      const shown = match === "none" ? [] : ranked;
      requests.push({
        ...base,
        raw_text: rnd.pick(PHRASES)(what, areaLabel),
        interpretation: { intent: "search", category_slug: line.slug, query: what, area: areaLabel, budget_usd: null, needed_by: null, clarifying_question: null, language: rnd.chance(0.25) ? "sn" : "en" },
        category_slug: line.slug,
        query: what,
        status: shown.length ? "answered" : "handoff",
        match,
        result_count: shown.length,
        understood_by: rnd.weighted([["local", 82], ["phrasebook", 8], ["customer", 5], ["claude", 5]] as const),
        product_matches: line.products ? productMatches ?? 0 : null,
      });
      shown.forEach((s, rank) => results.push({ request_id: id, business_id: s.b.id, rank, offering_id: s.has?.id ?? null }));
      if (!shown.length) {
        // Later, a store listed what they asked for, and we told them.
        if (productKey && rnd.chance(0.05) && customer) alerts.push({ request_id: id, contact_id: contactId, business_id: (byLine.get(line.slug) ?? [])[0]?.id, created_at: at(when + rnd.between(0.2, 3) * DAY) });
        continue;
      }

      // Most who get results choose one: the first more often, a cheaper one when prices show.
      if (!rnd.chance(product ? 0.5 : 0.42)) continue;
      const priced = shown.filter((s) => s.has);
      const cheapest = priced.length > 1 ? priced.reduce((a, b) => (a.has!.price <= b.has!.price ? a : b)) : null;
      const chosen = cheapest && rnd.chance(0.45) ? cheapest : shown[Math.min(shown.length - 1, rnd.weighted([[0, 55], [1, 30], [2, 15]] as const))]!;
      const picks = [chosen, ...(shown.length > 1 && rnd.chance(0.06) ? [shown.find((s) => s !== chosen)!] : [])];
      requests[requests.length - 1]!.status = "connected";
      for (const pick of picks) {
        const made = when + rnd.between(1, 30) * 60_000;
        const b = pick.b;
        let outcome: string | null = null;
        let rating: number | null = null;
        let followed: string | null = null;
        if (now.getTime() - made > 20 * 3600_000) {
          followed = at(made + 20 * 3600_000);
          const r = rnd.next();
          if (r < 0.12) outcome = null; // didn't answer the follow-up
          else if (r < 0.12 + 0.88 * b.quality * 0.85) outcome = "sorted";
          else outcome = rnd.weighted([["couldnt_help", 45], ["no_reply", 40 * (1.3 - b.quality)], ["not_yet", 25]] as const);
          if (outcome === "sorted" && rnd.chance(0.65)) rating = rnd.weighted([[5, 55], [4, 32], [3, 9], [2, 2.5], [1, 1.5]] as const);
          if ((outcome === "couldnt_help" || outcome === "no_reply") && rnd.chance(0.3)) rating = rnd.weighted([[1, 50], [2, 35], [3, 15]] as const);
          if (rating) {
            b.ratingSum += rating;
            b.ratingCount++;
          }
          if (outcome === "no_reply" && rnd.chance(0.06)) {
            const filed = made + rnd.between(1, 3) * DAY;
            reports.push({ contact_id: contactId, business_id: b.id, reason: rnd.pick(["They never replied", "The price was different", "They didn't have it"]), status: now.getTime() - filed < 10 * DAY ? "open" : rnd.pick(["reviewed", "actioned"]), created_at: at(filed), had_introduction: true });
          }
        }
        intros.push({ id: randomUUID(), ref_code: refCode(), request_id: id, contact_id: contactId, business_id: b.id, outcome, rating, followed_up_at: followed, created_at: at(made) });
      }
    }
  }

  // ----- Write it all.
  await db.transaction(async (tx) => {
    await insert(
      tx,
      "contacts",
      [["id", "uuid"], ["channel", "text"], ["wa_id", "text"], ["phone", "text"], ["profile_name", "text"], ["consent_at", "timestamptz"], ["last_inbound_at", "timestamptz"], ["created_at", "timestamptz"], ["stopped_at", "timestamptz"]],
      contacts.map((c) => ({ stopped_at: null, ...c })),
    );
    await insert(
      tx,
      "businesses",
      [["id", "uuid"], ["name", "text"], ["description", "text"], ["phone", "text"], ["area_id", "int"], ["lat", "float8"], ["lng", "float8"], ["verification", "text"], ["verified_at", "timestamptz"], ["verified_by", "text"], ["source", "text"], ["owner_contact_id", "uuid"], ["opted_in_at", "timestamptz"], ["response_score", "float8"], ["rating_sum", "int"], ["rating_count", "int"], ["is_sample", "boolean"], ["created_at", "timestamptz"], ["updated_at", "timestamptz"]],
      businesses.map((b) => ({
        id: b.id,
        name: b.name,
        description: `Sample listing for the dashboards (${lineOf.get(b.slug)!.names[0]!.toLowerCase()}).`,
        phone: b.owner ? (contacts.find((c) => c.id === b.owner)!.wa_id as string) : nextPhone(),
        area_id: b.area.id,
        lat: b.lat,
        lng: b.lng,
        verification: b.verified ? "verified" : "registered",
        verified_at: b.verified ? at(b.created + rnd.between(0, 14) * DAY) : null,
        verified_by: b.verified ? "sample" : null,
        source: b.owner ? (rnd.chance(0.7) ? "self" : "field") : rnd.pick(["field", "import"]),
        owner_contact_id: b.owner,
        opted_in_at: at(b.created),
        response_score: Math.round(b.quality * 100) / 100,
        rating_sum: b.ratingSum,
        rating_count: b.ratingCount,
        is_sample: true,
        created_at: at(b.created),
        updated_at: at(b.created),
      })),
    );
    await insert(tx, "business_categories", [["business_id", "uuid"], ["category_slug", "text"]], businesses.map((b) => ({ business_id: b.id, category_slug: b.slug })));
    await insert(
      tx,
      "offerings",
      [["id", "uuid"], ["business_id", "uuid"], ["name", "text"], ["price_usd", "numeric"], ["price_text", "text"], ["unit", "text"], ["in_stock", "boolean"], ["source", "text"], ["price_updated_at", "timestamptz"], ["created_at", "timestamptz"], ["updated_at", "timestamptz"], ["catalog_dirty", "boolean"]],
      productRows,
    );
    await insert(tx, "offering_price_changes", [["offering_id", "uuid"], ["business_id", "uuid"], ["old_price", "numeric"], ["new_price", "numeric"], ["reason", "text"], ["created_at", "timestamptz"]], priceChanges);
    await insert(
      tx,
      "requests",
      [["id", "uuid"], ["contact_id", "uuid"], ["raw_text", "text"], ["interpretation", "jsonb"], ["category_slug", "text"], ["query", "text"], ["area_id", "int"], ["lat", "float8"], ["lng", "float8"], ["status", "text"], ["match", "text"], ["result_count", "int"], ["understood_by", "text"], ["product_matches", "int"], ["buyer_business_id", "uuid"], ["created_at", "timestamptz"]],
      requests,
    );
    await insert(tx, "request_results", [["request_id", "uuid"], ["business_id", "uuid"], ["rank", "int"], ["offering_id", "uuid"]], results);
    await insert(
      tx,
      "introductions",
      [["id", "uuid"], ["ref_code", "text"], ["request_id", "uuid"], ["contact_id", "uuid"], ["business_id", "uuid"], ["outcome", "text"], ["rating", "int"], ["followed_up_at", "timestamptz"], ["created_at", "timestamptz"]],
      intros,
    );
    await insert(tx, "reports", [["contact_id", "uuid"], ["business_id", "uuid"], ["reason", "text"], ["status", "text"], ["created_at", "timestamptz"], ["had_introduction", "boolean"]], reports);
    await insert(tx, "product_alerts", [["request_id", "uuid"], ["contact_id", "uuid"], ["business_id", "uuid"], ["created_at", "timestamptz"]], alerts.filter((a) => a.business_id));
    const taken = new Set((await tx.query<{ code: string }>("SELECT code FROM web_registrations")).map((r) => r.code));
    await insert(tx, "web_registrations", [["code", "text"], ["details", "jsonb"], ["business_id", "uuid"], ["expires_at", "timestamptz"], ["completed_at", "timestamptz"], ["created_at", "timestamptz"]], dedupeCodes(registrations, taken));
    await insert(tx, "owner_sessions", [["token_hash", "text"], ["contact_id", "uuid"], ["expires_at", "timestamptz"], ["created_at", "timestamptz"]], sessions);
  });

  // The busiest owned shop, to try the business dashboard with.
  const connectionsOf = new Map<string, number>();
  for (const i of intros) connectionsOf.set(i.business_id as string, (connectionsOf.get(i.business_id as string) ?? 0) + 1);
  const showcase = businesses
    .filter((b) => b.owner && b.products.size >= 4 && b.area.city === "Harare")
    .sort((a, b) => (connectionsOf.get(b.id) ?? 0) - (connectionsOf.get(a.id) ?? 0))[0]!;
  return {
    businesses: businesses.length,
    products: productRows.length,
    customers: customers.length,
    requests: requests.length,
    connections: intros.length,
    showcase: { id: showcase.id, name: showcase.name, ownerContactId: showcase.owner! },
  };
}

/** Registration codes are unique: drop the odd repeat the random numbers produce, or a code in use. */
function dedupeCodes(rows: Record<string, unknown>[], taken: Set<unknown>): Record<string, unknown>[] {
  return rows.filter((r) => !taken.has(r.code) && taken.add(r.code));
}
