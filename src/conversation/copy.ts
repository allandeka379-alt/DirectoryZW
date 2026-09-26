import type { OutboundMessage } from "../whatsapp/outbound.js";
import { Ids } from "./ids.js";

/** What customers see about a business in lists and cards. */
export interface BusinessView {
  id: string;
  name: string;
  description: string;
  verification: "verified" | "registered";
  areaName: string | null;
  distanceKm: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  /** When our team last checked it in person (cards only). */
  verifiedAt?: Date | null;
  /** How customers got on with it recently (cards only). */
  record?: { answered: number; sorted: number };
}

/** Customers see a track record from this many answers (TRACK_RECORD_MIN in directory/trust.ts). */
const TRACK_RECORD_SHOWN_FROM = 5;

/** Price-list items that match the request, shown on a business card. */
export interface PriceView {
  items: { name: string; price: string | null }[];
  updatedAt: Date;
}

const UNVERIFIED_WARNING = "⚠️ Not yet checked by our team. Don't pay a deposit before you see the item or the work.";

/**
 * What the customer asked for, as replies name it (see need() in customer.ts):
 * - goods: what the stores have, in the customer's words when they fit ("samsung tv")
 * - service: what the businesses offer ("plumbing services"), never "businesses for plumber"
 * - other: no category; their words, as something businesses "can help with"
 */
export interface Need {
  kind: "goods" | "service" | "other";
  text: string;
  /** A business looking for supplies: results are "suppliers". */
  trade?: boolean;
}

/** One place that has or does what they asked for: "a store", "a business", or "a supplier" for a business. */
function aPlace(need: Need): string {
  return need.trade ? "a supplier" : need.kind === "goods" ? "a store" : "a business";
}

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "two", "ten": small numbers in words, as in a sentence. */
function inWords(n: number): string {
  return NUMBERS[n] ?? String(n);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "near Avondale that offer *plumbing services*": what the businesses have or do, after their
 * noun. `n` makes the verb agree ("a store … has", "two stores … have").
 */
function whatTheyDo(need: Need, n: number, near: string): string {
  const one = n === 1;
  switch (need.kind) {
    case "goods":
      return `${near} with *${need.text}*`;
    case "service":
      return `${near} that ${one ? "offers" : "offer"} *${need.text}*`;
    case "other":
      return `${near} that can help with *${need.text}*`;
  }
}

function firstName(name?: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function badge(b: BusinessView): string {
  return b.verification === "verified" ? "✅ Verified" : "Not yet verified";
}

function rating(b: BusinessView): string | null {
  return b.ratingAvg != null && b.ratingCount >= 1 ? `★${b.ratingAvg.toFixed(1)} (${b.ratingCount})` : null;
}

function distance(b: BusinessView): string | null {
  if (b.distanceKm == null) return null;
  return b.distanceKm < 1 ? "under 1 km" : `${b.distanceKm.toFixed(b.distanceKm < 10 ? 1 : 0)} km`;
}

// ---------- Customer number ----------

export function consent(brand: string, privacyUrl: string | undefined, name: string | null): OutboundMessage {
  const hi = firstName(name) ? `Hi ${firstName(name)}!` : "Hi!";
  const privacy = privacyUrl ? ` Privacy notice: ${privacyUrl}` : "";
  return {
    kind: "buttons",
    body:
      `${hi} I'm *${brand}*. Tell me what you need, whether it's a product, a service or anything else, and I'll find businesses near you. It's free.\n\n` +
      "✅ Every business we verify is visited in person by our team, and we check who runs it, so you know it's genuine and reliable. " +
      "Customers rate the businesses they contact, and we look into every report.\n\n" +
      `We keep your messages to help you, and only share your request with businesses you choose to contact.${privacy}\n\n` +
      "Tap *I agree* to start.",
    buttons: [{ id: Ids.consent, title: "I agree" }],
  };
}

export function askWhatYouNeed(name?: string | null): OutboundMessage {
  const who = firstName(name) ? `, ${firstName(name)}` : "";
  return {
    kind: "text",
    text:
      `What are you looking for${who}? For example:\n` +
      "• A 55-inch Samsung TV under $600 in Avondale\n" +
      "• A plumber in Mabelreign tomorrow\n" +
      "• 100 chairs and a tent for Saturday\n" +
      "• A solar installer in Bulawayo",
  };
}

export function help(brand: string): OutboundMessage {
  return {
    kind: "text",
    text:
      `*How ${brand} works*\n` +
      "1. Type what you need and where, for example *plumber in Mabelreign*.\n" +
      "2. I show businesses that can help. ✅ means our team checked them in person.\n" +
      "3. Pick one and tap *Connect me* to chat with them directly on WhatsApp.\n\n" +
      "Type *recommend* to tell us about a good business we should list, *agent* to talk to a person, or *menu* to start again.",
  };
}

export function askLocation(need: Need): OutboundMessage {
  return { kind: "location_request", body: `Where should I look for *${need.text}*? Share your location, or type your suburb or town.` };
}

export function locationSaved(place: string): OutboundMessage {
  return { kind: "text", text: `Thanks, I'll search near *${place}*. What are you looking for?` };
}

/** A row under the results for telling us we got it wrong: it feeds the team's weekly check. */
function notWhatIAskedRow(requestId: string) {
  return { id: Ids.notIt(requestId), title: "Not what I asked for", description: "Tell me again, or talk to a person" };
}

function businessRows(requestId: string, hits: BusinessView[]) {
  return hits.map((h) => ({
    id: Ids.business(requestId, h.id),
    title: h.name,
    description: [badge(h), h.areaName, distance(h), rating(h)].filter(Boolean).join(" · "),
  }));
}

function unverifiedNote(hits: BusinessView[]): string {
  return hits.some((h) => h.verification !== "verified")
    ? "\n⚠️ Businesses without ✅ signed up themselves. Don't pay a deposit before you see the item or the work."
    : "";
}

/**
 * Results, said with confidence: the businesses our team verified, and what they have (stores,
 * for categories that sell goods) or offer (services). "We have two stores near Avondale that our
 * team has verified, and they have *samsung tv*"; "We have two businesses near Mabelreign that
 * offer *plumbing services*, and our team has verified them". Businesses that listed themselves
 * only fill gaps (see searchBusinesses); they're counted apart, with a warning.
 */
export function results(
  requestId: string,
  hits: BusinessView[],
  need: Need,
  place?: string,
  /** A business looking for supplies that no wholesaler has: these are retail stores in that line. */
  opts: { retailInstead?: boolean } = {},
): OutboundMessage {
  const shown = hits.slice(0, 9);
  const verified = shown.filter((h) => h.verification === "verified");
  const unchecked = shown.filter((h) => h.verification !== "verified");
  const near = place ? ` near ${place}` : "";
  const goods = need.kind === "goods";
  const suppliers = need.trade && !opts.retailInstead;
  const noun = (n: number) =>
    suppliers ? (n === 1 ? "supplier" : "suppliers") : goods ? (n === 1 ? "store" : "stores") : n === 1 ? "business" : "businesses";
  const some = (n: number) => (n === 1 ? `a ${noun(1)}` : `${inWords(n)} ${noun(n)}`);
  const them = (n: number) => (n === 1 ? "it" : "them");

  let body: string;
  if (verified.length) {
    const v = verified.length;
    body = goods
      ? `We have ${some(v)}${near} that our team has verified, and ${v === 1 ? "it has" : "they have"} *${need.text}*.`
      : `We have ${some(v)}${whatTheyDo(need, v, near)}, and our team has verified ${them(v)}.`;
    if (unchecked.length) {
      const u = unchecked.length;
      body += ` ${capitalize(inWords(u))} more listed ${u === 1 ? "itself" : "themselves"} and ${u === 1 ? "hasn't" : "haven't"} been checked by our team yet.`;
    }
  } else {
    const u = unchecked.length;
    body =
      `We don't have a verified ${noun(1)}${whatTheyDo(need, 1, near)} yet. ${u === 1 ? "This one" : `These ${inWords(u)}`} listed ` +
      `${u === 1 ? "itself" : "themselves"} and ${u === 1 ? "hasn't" : "haven't"} been checked by our team.`;
  }
  body += ` Tap ${shown.length === 1 ? "it" : "one"} to connect with them.`;
  if (unchecked.length) body += "\n\n⚠️ Don't pay a deposit before you see the item or the work.";
  if (opts.retailInstead) {
    body =
      (goods
        ? `No wholesaler we list has *${need.text}* yet, so here are retail stores that do.\n\n`
        : `No wholesaler we list offers *${need.text}* yet, so here are businesses that do.\n\n`) + body;
  }

  return {
    kind: "list",
    body,
    button: suppliers ? "See suppliers" : goods ? "See stores" : "See businesses",
    sections: [
      { title: "Verified by our team", rows: businessRows(requestId, verified) },
      { title: "Not checked yet", rows: businessRows(requestId, unchecked) },
      { title: "Not right?", rows: [notWhatIAskedRow(requestId)] },
    ].filter((s) => s.rows.length),
    // On the business number, "menu" goes back to the business menu.
    footer: need.trade ? "Type menu for your business menu" : "Type menu to start a new search",
  };
}

/**
 * Nobody lists what they asked for, but suppliers in related categories might have it or know
 * where to get it: "these electronics and appliances businesses".
 */
export function relatedResults(requestId: string, hits: BusinessView[], need: Need, label: string, place?: string): OutboundMessage {
  const near = place ? ` near ${place}` : "";
  const missing = `${aPlace(need)}${whatTheyDo(need, 1, near)}`;
  const maybe = need.kind === "goods" ? "may have it or know where to get it" : "may be able to help";
  return {
    kind: "list",
    body:
      `We don't have ${missing} yet, but these ${label} ${maybe}. ` +
      `Tap *See options*.\n\n✅ = checked in person by our team.${unverifiedNote(hits)}`,
    button: "See options",
    sections: [
      { title: "Businesses", rows: businessRows(requestId, hits.slice(0, 8)) },
      {
        title: "Not what you need?",
        rows: [{ id: Ids.human(requestId), title: "Talk to a person", description: "Someone from our team helps you find it" }, notWhatIAskedRow(requestId)],
      },
    ],
    // On the business number, "menu" goes back to the business menu.
    footer: need.trade ? "Type menu for your business menu" : "Type menu to start a new search",
  };
}

/**
 * A business: when our team checked it, how customers got on with it through us (once enough of
 * them have said), its description and matching prices.
 */
export function businessCard(requestId: string, b: BusinessView, prices?: PriceView): OutboundMessage {
  const verified =
    b.verification === "verified" && b.verifiedAt
      ? `✅ Verified by our team in ${b.verifiedAt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "Africa/Harare" })}`
      : badge(b);
  const details = [verified, b.areaName, distance(b) ? `${distance(b)} away` : null, rating(b)].filter(Boolean).join(" · ");
  const record =
    b.record && b.record.answered >= TRACK_RECORD_SHOWN_FROM
      ? `\n👍 ${b.record.sorted} of the last ${b.record.answered} customers we sent them got what they needed`
      : "";
  const buttons = [{ id: Ids.connect(requestId, b.id), title: "Connect me" }];
  if (requestId) buttons.push({ id: Ids.list(requestId), title: "Other options" });
  buttons.push({ id: Ids.report(b.id), title: "Report" });
  const priceLines = prices?.items.length
    ? `\n\n🏷️ From their price list (${prices.updatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Harare" })}):\n` +
      prices.items.map((i) => `• ${i.name}${i.price ? `: ${i.price}` : ""}`).join("\n") +
      "\nPrices may have changed, so confirm with them."
    : "";
  return {
    kind: "buttons",
    body: `*${b.name}*\n${details}${record}${b.description ? `\n\n${b.description}` : ""}${priceLines}${b.verification === "verified" ? "" : `\n\n${UNVERIFIED_WARNING}`}`,
    buttons,
  };
}

/** A business contacting a supplier: it says which business is asking. */
export function prefilledTradeMessage(brand: string, supplierName: string, buyerName: string, refCode: string, summary: string): string {
  return `Hi ${supplierName}, this is ${buyerName}. We found you on ${brand} (ref ${refCode}). We're looking for: ${summary}`;
}

export function prefilledMessage(brand: string, businessName: string, refCode: string, summary: string): string {
  return `Hi ${businessName}, I found you on ${brand} (ref ${refCode}). I'm looking for: ${summary}`;
}

export function connectLink(b: BusinessView, url: string, refCode: string): OutboundMessage {
  return {
    kind: "cta_url",
    body:
      `Tap below to chat with *${b.name}* on WhatsApp. Your message is ready, so just press send.` +
      `\n\nReference: *${refCode}*` +
      (b.verification === "verified" ? "" : `\n\n${UNVERIFIED_WARNING}`),
    displayText: "Chat with them",
    url,
  };
}

/**
 * Nothing on our list: a person takes over straight away, in the same reply. `when` says when a
 * person will reply (see whenTeamReplies).
 */
export function noSupplierHandoff(need: Need, place: string | undefined, when: string): OutboundMessage {
  const near = place ? ` near ${place}` : "";
  const missing = `${aPlace(need)}${whatTheyDo(need, 1, near)}`;
  return {
    kind: "text",
    text:
      `We don't have ${missing} on our list yet, so I've passed your request to our team ` +
      `to help you find it. ${when}\n\n` +
      "Know a good business that does this? Tell the team, and we'll invite them. Type *menu* to go back to the assistant.",
  };
}

export function notUnderstoodHandoff(when: string): OutboundMessage {
  return {
    kind: "text",
    text: `Sorry, I'm still not sure what you need, so I've passed your message to our team. ${when} Type *menu* to go back to the assistant.`,
  };
}

/** The customer says we've got it wrong ("you don't understand"): a person takes over. */
export function frustratedHandoff(when: string): OutboundMessage {
  return {
    kind: "text",
    text: `Sorry, I'm not getting this right. I've passed your chat to our team. ${when} Type *menu* to go back to the assistant.`,
  };
}

/** They tapped "Not what I asked for" under results. */
export function notWhatIAsked(requestId: string): OutboundMessage {
  return {
    kind: "buttons",
    body: "Sorry about that. Tell me again in other words what you need, and I'll look again.",
    buttons: [{ id: Ids.human(requestId), title: "Talk to a person" }],
  };
}

// ---------- Recommendations ----------

export function recAskName(): OutboundMessage {
  return { kind: "text", text: "Thanks for helping! What's the business called? (Type *cancel* to stop.)" };
}

export function recAskWhat(name: string): OutboundMessage {
  return { kind: "text", text: `What does *${name}* sell or do?` };
}

export function recAskArea(name: string): OutboundMessage {
  return { kind: "location_request", body: `Where is *${name}*? Share the location, or type the suburb or town.` };
}

export function recAskPhone(name: string): OutboundMessage {
  return { kind: "text", text: `What's *${name}*'s WhatsApp number? Type *skip* if you don't know it.` };
}

export function recBadPhone(): OutboundMessage {
  return { kind: "text", text: "That doesn't look like a phone number. Try again (for example 0771234567), or type *skip*." };
}

export function recThanks(name: string): OutboundMessage {
  return {
    kind: "text",
    text: `Thank you! Our team will contact *${name}* and list them for free if they agree. We won't tell them who recommended them.\n\nWhat are you looking for?`,
  };
}

export function recAlreadyListed(name: string): OutboundMessage {
  return { kind: "text", text: `Thanks! *${name}* is already listed with us. What are you looking for?` };
}

export function recCancelled(): OutboundMessage {
  return { kind: "text", text: "No problem. What are you looking for?" };
}

export function handoff(when: string): OutboundMessage {
  return {
    kind: "text",
    text: `Okay, I've passed your chat to our team. ${when} Type *menu* to go back to the assistant.`,
  };
}

export function welcomeBack(): OutboundMessage {
  return { kind: "text", text: "You're back with the assistant. What are you looking for?" };
}

export function outOfScope(): OutboundMessage {
  return { kind: "text", text: "I can only help you find businesses and services. What are you looking for?" };
}

export function blocked(): OutboundMessage {
  return { kind: "text", text: "Sorry, I can't help with that. I can help you find other products and services." };
}

export function restricted(categoryName: string): OutboundMessage {
  return { kind: "text", text: `Sorry, I can't search for ${categoryName.toLowerCase()} yet. We're adding more services soon.` };
}

export function clarify(question: string | null): OutboundMessage {
  return { kind: "text", text: question ?? "What are you looking for? Tell me the product or service, and your area." };
}

/** We're not sure which category they mean (or it rests on words nobody has checked yet), so they pick. */
export function didYouMean(options: { slug: string; name: string; short: string }[]): OutboundMessage {
  const [only] = options;
  if (options.length === 1 && only) {
    return {
      kind: "buttons",
      body: `Just to check, do you mean *${only.name}*?`,
      buttons: [
        { id: Ids.mean(only.slug), title: "Yes" },
        { id: Ids.meanOther, title: "No, something else" },
      ],
    };
  }
  if (options.length === 2) {
    return {
      kind: "buttons",
      body: `Which of these do you need?\n• ${options.map((o) => o.name).join("\n• ")}`,
      buttons: [...options.map((o) => ({ id: Ids.mean(o.slug), title: o.short })), { id: Ids.meanOther, title: "Something else" }],
    };
  }
  return {
    kind: "list",
    body: "Which of these do you need? Tap *Choose*.",
    button: "Choose",
    sections: [
      {
        title: "Did you mean",
        rows: [
          ...options.map((o) => ({ id: Ids.mean(o.slug), title: o.short, description: o.name })),
          { id: Ids.meanOther, title: "Something else", description: "Tell me in other words" },
        ],
      },
    ],
  };
}

export function sayItDifferently(): string {
  return 'OK. Please tell me in other words what you need, for example "fridge repair in Glen View" or "tents to hire".';
}

/** Voice notes and photos: the assistant reads typed messages only, for now. */
export function typeInstead(): OutboundMessage {
  return {
    kind: "text",
    text: 'I can only read typed messages for now. Please type what you need, for example "plumber in Mabelreign" or "fridge repair in Glen View".',
  };
}

export function slowDown(): OutboundMessage {
  return { kind: "text", text: "You're sending messages faster than I can answer. Please wait a few minutes, then try again." };
}

export function noLongerAvailable(): OutboundMessage {
  return { kind: "text", text: "Sorry, that business is no longer available. Please pick another one." };
}

export function followUp(introId: string, businessName: string): OutboundMessage {
  return {
    kind: "buttons",
    body: `Did you get what you needed from *${businessName}*?`,
    buttons: [
      { id: Ids.feedback(introId, "sorted"), title: "Yes, sorted" },
      { id: Ids.feedback(introId, "not_yet"), title: "Not yet" },
      { id: Ids.feedback(introId, "failed"), title: "It didn't work out" },
    ],
  };
}

/** After "It didn't work out": what went wrong, so we can hold the business to our promise. */
export function whatHappened(introId: string, goods: boolean): OutboundMessage {
  return {
    kind: "buttons",
    body: "Sorry about that. What happened?",
    buttons: [
      { id: Ids.feedback(introId, "no_reply"), title: "They didn't reply" },
      { id: Ids.feedback(introId, "couldnt_help"), title: goods ? "Didn't have it" : "Couldn't help" },
      { id: Ids.feedback(introId, "other"), title: "Something else" },
    ],
  };
}

export function askRating(introId: string, businessName: string): OutboundMessage {
  return {
    kind: "buttons",
    body: `Great! How was *${businessName}*?`,
    buttons: [
      { id: Ids.rate(introId, 5), title: "😀 Great" },
      { id: Ids.rate(introId, 3), title: "😐 OK" },
      { id: Ids.rate(introId, 1), title: "😞 Poor" },
    ],
  };
}

export function ratingThanks(): OutboundMessage {
  return {
    kind: "text",
    text: "Thanks! Your rating helps other customers choose.\n\nKnow another good business that isn't listed with us? Type *recommend*.",
  };
}

export function notYet(requestId: string | null): OutboundMessage {
  const buttons = requestId ? [{ id: Ids.list(requestId), title: "Other options" }] : [];
  return {
    kind: "buttons",
    body: "No problem. Would you like to see the other options?",
    buttons: [...buttons, { id: Ids.newSearch, title: "New search" }],
  };
}

/**
 * They didn't reply, or couldn't help. It counts against the business: those that keep letting
 * customers down go back to our field team (see recheckQueue).
 */
export function letDown(requestId: string | null, businessId: string, what: "no_reply" | "couldnt_help", goods: boolean): OutboundMessage {
  const buttons = requestId ? [{ id: Ids.list(requestId), title: "Other options" }] : [];
  const sorry = what === "no_reply" ? "Sorry they didn't reply." : goods ? "Sorry they didn't have it." : "Sorry they couldn't help.";
  return {
    kind: "buttons",
    body:
      `${sorry} Thanks for telling us: our team checks again any business that keeps letting customers down.\n\n` +
      `Would you like to try another ${goods ? "store" : "business"}?`,
    buttons: [...buttons, { id: Ids.report(businessId), title: "Report them" }, { id: Ids.newSearch, title: "New search" }],
  };
}

/** Everyone we had for this request has been tried. */
export function noOtherOptions(requestId: string): OutboundMessage {
  return {
    kind: "buttons",
    body: "We don't have any other businesses for that yet. Would you like someone from our team to help you find one?",
    buttons: [
      { id: Ids.human(requestId), title: "Talk to a person" },
      { id: Ids.newSearch, title: "New search" },
    ],
  };
}

export function askReport(): OutboundMessage {
  return { kind: "text", text: 'What went wrong? Type a short note, for example "asked for a deposit and disappeared".' };
}

export function reportThanks(): OutboundMessage {
  return { kind: "text", text: "Thank you. Our team will look into it. What else can I help you find?" };
}

export function eraseConfirm(): OutboundMessage {
  return {
    kind: "buttons",
    body:
      "Delete everything we hold about you? This removes your messages, requests and ratings, and can't be undone.\n\n" +
      "Businesses you contacted keep their own WhatsApp chats with you.",
    buttons: [
      { id: Ids.eraseYes, title: "Delete everything" },
      { id: Ids.eraseNo, title: "Keep my data" },
    ],
  };
}

export function erased(): OutboundMessage {
  return { kind: "text", text: "Done. We've deleted everything we held about you. If you message us again, we'll start fresh." };
}

export function eraseCancelled(): OutboundMessage {
  return { kind: "text", text: "Okay, nothing was deleted. What are you looking for?" };
}

export function reportLimit(): OutboundMessage {
  return { kind: "text", text: "Thanks, we've already had several reports from you today. Our team will look into them." };
}

export function stopped(): OutboundMessage {
  return { kind: "text", text: "Okay, I won't message you unless you write to me again. Type *menu* any time to search." };
}

// ---------- Business number ----------

/** `buyer`: another business looking for supplies, named so the supplier knows who's asking. */
export function leadNotification(
  brand: string,
  refCode: string,
  summary: string,
  place?: string | null,
  neededBy?: string | null,
  buyer?: { name: string } | null,
): OutboundMessage {
  return {
    kind: "text",
    text:
      (buyer
        ? `🔔 *New trade customer from ${brand}* (ref ${refCode})\n*${buyer.name}* is looking for: ${summary}`
        : `🔔 *New customer from ${brand}* (ref ${refCode})\nLooking for: ${summary}`) +
      (place ? `\nArea: ${place}` : "") +
      (neededBy ? `\nNeeded: ${neededBy}` : "") +
      "\n\nThey'll message you on WhatsApp shortly. Businesses that reply quickly show higher in results.",
  };
}

export function bizWelcome(brand: string): OutboundMessage {
  return {
    kind: "buttons",
    body: `Welcome to *${brand} for businesses*. People across Zimbabwe ask us for products and services every day. List your business free and we'll send customers your way.`,
    buttons: [
      { id: Ids.register, title: "List my business" },
      { id: Ids.howItWorks, title: "How it works" },
    ],
  };
}

export function bizHowItWorks(brand: string): OutboundMessage {
  return {
    kind: "buttons",
    body:
      "*How it works*\n" +
      `1. Customers tell ${brand} what they need on WhatsApp.\n` +
      "2. We show matching businesses nearby, verified ones first.\n" +
      "3. When a customer taps *Connect me*, they message you directly and we let you know here.\n\n" +
      "Listing is free. A field agent may visit to verify you, which moves you up the results.",
    buttons: [{ id: Ids.register, title: "List my business" }],
  };
}

export function regAskName(): OutboundMessage {
  return { kind: "text", text: "Great! What's the name of your business? (Type *cancel* to stop.)" };
}

export function regAskWhat(): OutboundMessage {
  return {
    kind: "text",
    text: 'What do you sell or do? One sentence is enough, for example "We sell and install solar systems" or "Plumbing repairs and geyser installation".',
  };
}

const PICK_PER_PAGE = 9;

/** First step of choosing a category by hand: the kind of business. */
export function pickGroup(groups: string[], page: number, intro = "Which of these best describes your business?"): OutboundMessage {
  const start = page * PICK_PER_PAGE;
  const rows: { id: string; title: string; description?: string }[] = groups
    .slice(start, start + PICK_PER_PAGE)
    .map((g, i) => ({ id: Ids.pickGroup(start + i), title: g, description: g }));
  if (start + PICK_PER_PAGE < groups.length) rows.push({ id: Ids.pickGroupsPage(page + 1), title: "More…", description: "Other kinds of business" });
  return { kind: "list", body: intro, button: "Choose", sections: [{ title: "Kinds of business", rows }] };
}

/** Second step: the category within that kind. */
export function pickCategory(group: string, groupIndex: number, categories: { slug: string; name: string }[], page: number): OutboundMessage {
  const start = page * PICK_PER_PAGE;
  const rows: { id: string; title: string; description?: string }[] = categories
    .slice(start, start + PICK_PER_PAGE)
    .map((c) => ({ id: Ids.pickCategory(c.slug), title: c.name, description: c.name }));
  if (start + PICK_PER_PAGE < categories.length) {
    rows.push({ id: Ids.pickCategoriesPage(groupIndex, page + 1), title: "More…", description: `More in ${group}` });
  } else {
    rows.push({ id: Ids.pickGroupsPage(0), title: "Back", description: "Other kinds of business" });
  }
  return { kind: "list", body: `*${group}*: which one fits best?`, button: "Choose", sections: [{ title: group.slice(0, 24), rows }] };
}

export function regConfirmCategories(names: string[]): OutboundMessage {
  return {
    kind: "buttons",
    body: `I'll list you under:\n• ${names.join("\n• ")}\n\nIs that right?`,
    buttons: [
      { id: Ids.categoriesOk, title: "Yes, that's right" },
      { id: Ids.categoriesChange, title: "Change it" },
    ],
  };
}

export function regAskArea(): OutboundMessage {
  return { kind: "location_request", body: "Where is your business? Share your location, or type your suburb or town." };
}

export function regUnknownArea(): OutboundMessage {
  return {
    kind: "text",
    text: 'I couldn\'t find that place. Type your suburb or town (for example "Avondale" or "Bulawayo CBD"), or share your location.',
  };
}

export function regAskPhone(): OutboundMessage {
  return {
    kind: "buttons",
    body: "Which WhatsApp number should customers message?",
    buttons: [
      { id: Ids.phoneThis, title: "This number" },
      { id: Ids.phoneOther, title: "Another number" },
    ],
  };
}

export function regAskOtherPhone(): OutboundMessage {
  return { kind: "text", text: "Type the number, for example 0771234567." };
}

export function regBadPhone(): OutboundMessage {
  return { kind: "text", text: "That doesn't look like a valid number. Try again, for example 0771234567." };
}

export function regConsent(termsUrl?: string): OutboundMessage {
  return {
    kind: "buttons",
    body: `Last step: customers will see your business name, area and WhatsApp number. You agree to our business terms${termsUrl ? ` (${termsUrl})` : ""}. Listing is free.`,
    buttons: [{ id: Ids.agree, title: "I agree" }],
  };
}

export function regDone(name: string): OutboundMessage {
  return {
    kind: "text",
    text:
      `You're listed! Customers can now find *${name}*.\n\nA field agent may visit to verify you, and verified businesses show first. ` +
      "Do you also sell wholesale to other businesses? Choose *Who I sell to* in the menu. Type *menu* any time for your options.",
  };
}

// ---------- Businesses buying from suppliers ----------

export function askWhatToBuy(businessName: string, area: string | null): OutboundMessage {
  return {
    kind: "text",
    text:
      `What does *${businessName}* need to buy? Type it the way you'd ask a supplier, for example *cement, 100 bags* or *cooking oil wholesale*.\n\n` +
      `I'll find wholesalers and suppliers${area ? ` near ${area}` : ""}, the ones our team has verified first. Type *menu* to go back.`,
  };
}

const TRADE_LABELS: Record<string, string> = {
  retail: "the public",
  wholesale: "other businesses (wholesale)",
  both: "the public and other businesses",
};

export function askTrade(current: string): OutboundMessage {
  return {
    kind: "buttons",
    body:
      `Right now you sell to ${TRADE_LABELS[current] ?? "the public"}.\n\n` +
      "Who do you sell to? Businesses that sell wholesale show up when other businesses look for suppliers. Wholesale-only businesses don't show in the public's searches.",
    buttons: [
      { id: Ids.setTrade("retail"), title: "The public" },
      { id: Ids.setTrade("wholesale"), title: "Other businesses" },
      { id: Ids.setTrade("both"), title: "Both" },
    ],
  };
}

export function tradeSaved(name: string, trade: string): OutboundMessage {
  return { kind: "text", text: `Saved: *${name}* sells to ${TRADE_LABELS[trade] ?? trade}. Type *menu* for your options.` };
}

export function regCancelled(): OutboundMessage {
  return { kind: "text", text: "Registration cancelled. Type *register* when you're ready." };
}

/** The owner's menu, with their week at the top: free to show, unlike a Monday summary. */
export function bizMenu(
  b: { name: string; status: string; verification: string },
  ownsSeveral: boolean,
  week?: { shown: number; intros: number },
): OutboundMessage {
  const rows: { id: string; title: string; description?: string }[] = [
    { id: Ids.summary, title: "My summary", description: "Searches, customers and rating" },
    { id: Ids.myCustomers, title: "My customers", description: "Who contacted you through us" },
    { id: Ids.findSupplier, title: "Find a supplier", description: "Wholesalers for your own stock" },
    { id: Ids.editWhat, title: "Update what I sell", description: "Description and categories" },
    { id: Ids.editArea, title: "Update location", description: "Where customers find you" },
    { id: Ids.sellsTo, title: "Who I sell to", description: "The public, businesses (wholesale) or both" },
    b.status === "paused"
      ? { id: Ids.resume, title: "Resume listing", description: "Show me to customers again" }
      : { id: Ids.pause, title: "Pause listing", description: "Hide me from customers for now" },
    { id: Ids.remove, title: "Remove listing" },
    { id: Ids.register, title: "Add another business" },
  ];
  if (ownsSeveral) rows.push({ id: Ids.switchBusiness, title: "Switch business", description: "Manage one of your other listings" });
  return {
    kind: "list",
    body:
      `*${b.name}*\n${b.verification === "verified" ? "✅ Verified" : "Not yet verified"} · ${b.status === "paused" ? "Paused" : "Live"}` +
      (week
        ? `\nThis week: shown in ${week.shown} search${week.shown === 1 ? "" : "es"} · ${week.intros} customer${week.intros === 1 ? "" : "s"} connected`
        : "") +
      "\n\nWhat would you like to do?",
    button: "Options",
    sections: [{ title: "Your listing", rows }],
  };
}

export function chooseBusiness(businesses: { id: string; name: string; status: string }[]): OutboundMessage {
  return {
    kind: "list",
    body: "Which business would you like to manage?",
    button: "Choose",
    sections: [
      {
        title: "Your businesses",
        rows: businesses.map((b) => ({ id: Ids.selectBusiness(b.id), title: b.name, description: b.status === "paused" ? "Paused" : "Live" })),
      },
    ],
  };
}

export function editConfirmCategories(names: string[]): OutboundMessage {
  return {
    kind: "buttons",
    body: `I'll list you under:\n• ${names.join("\n• ")}\n\nSave this?`,
    buttons: [
      { id: Ids.editSave, title: "Save" },
      { id: Ids.categoriesChange, title: "Change it" },
    ],
  };
}

export function listingUpdated(name: string): OutboundMessage {
  return { kind: "text", text: `Done, *${name}* is updated. Type *menu* for your options.` };
}

/** Voice notes and photos on the business number. */
export function bizTypeInstead(): OutboundMessage {
  return { kind: "text", text: "I can only read typed messages for now. Type *menu* for your options." };
}

export function weeklySummary(brand: string, name: string, shown: number, intros: number): OutboundMessage {
  return {
    kind: "text",
    text:
      `📊 *Your week on ${brand}*\n*${name}*\n` +
      `• Shown in ${shown} search${shown === 1 ? "" : "es"}\n` +
      `• ${intros} customer${intros === 1 ? "" : "s"} connected with you\n\n` +
      "Reply quickly to customers to show higher in results. Type *menu* to update your listing.",
  };
}

export function bizSummary(name: string, shown: number, intros: number, ratingAvg: number | null, ratingCount: number): OutboundMessage {
  return {
    kind: "text",
    text:
      `*${name}*, last 7 days:\n` +
      `• Shown in ${shown} search${shown === 1 ? "" : "es"}\n` +
      `• ${intros} customer${intros === 1 ? "" : "s"} connected with you\n` +
      `• Rating: ${ratingAvg != null && ratingCount ? `★${ratingAvg.toFixed(1)} from ${ratingCount}` : "no ratings yet"}`,
  };
}

/**
 * Customers who contacted the business through us, by reference code. Lead notices go out only
 * when they're free, so this is where an owner can always check.
 */
export function myCustomers(businessName: string, leads: { ref: string; at: Date; what: string | null; outcome: string | null }[]): OutboundMessage {
  if (!leads.length) {
    return { kind: "text", text: `No customers have contacted *${businessName}* through us in the last 30 days yet. Type *menu* for your options.` };
  }
  const outcome: Record<string, string> = { sorted: " · ✅ sorted", couldnt_help: " · couldn't help", no_reply: " · said you didn't reply" };
  const lines = leads.map(
    (l) =>
      `• *${l.ref}* · ${l.at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Harare" })}` +
      (l.what ? ` · ${l.what.length > 50 ? `${l.what.slice(0, 49)}…` : l.what}` : "") +
      (l.outcome ? (outcome[l.outcome] ?? "") : ""),
  );
  return {
    kind: "text",
    text:
      `Customers who contacted *${businessName}* through us, last 30 days:\n${lines.join("\n")}\n\n` +
      "They message you directly on WhatsApp, with the reference in their first message. Type *menu* for your options.",
  };
}

export function bizPaused(): OutboundMessage {
  return { kind: "text", text: "Your listing is paused. Customers won't see it until you type *resume*." };
}

export function bizResumed(): OutboundMessage {
  return { kind: "text", text: "Your listing is live again." };
}

export function bizConfirmRemove(): OutboundMessage {
  return {
    kind: "buttons",
    body: "Remove your listing? Customers won't be able to find you. You can register again any time.",
    buttons: [
      { id: Ids.removeConfirm, title: "Yes, remove it" },
      { id: Ids.menu, title: "Keep it" },
    ],
  };
}

export function bizRemoved(): OutboundMessage {
  return { kind: "text", text: "Your listing has been removed." };
}

export function bizEraseConfirm(listings: string[]): OutboundMessage {
  const what = listings.length
    ? `your chats with us and your listing${listings.length === 1 ? "" : "s"}: *${listings.join("*, *")}*. Customers won't find you any more`
    : "your chats with us";
  return {
    kind: "buttons",
    body: `Delete everything we hold about you? This removes ${what}. It can't be undone.`,
    buttons: [
      { id: Ids.eraseYes, title: "Delete everything" },
      { id: Ids.eraseNo, title: "Keep my data" },
    ],
  };
}

export function bizErased(): OutboundMessage {
  return { kind: "text", text: "Done. Your listings and everything we held about you are deleted. You can register again any time." };
}

export function bizNoListing(): OutboundMessage {
  return { kind: "text", text: "You don't have a listing yet. Type *register* to list your business." };
}
