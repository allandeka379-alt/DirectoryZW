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
}

/** A business found on the web, as customers see it. */
export interface LeadView {
  id: string;
  name: string;
  description: string;
  areaName: string | null;
  distanceKm: number | null;
  /** Website the details came from, e.g. "facebook.com". */
  source: string | null;
}

/** Price-list items that match the request, shown on a business card. */
export interface PriceView {
  items: { name: string; price: string | null }[];
  updatedAt: Date;
}

const UNVERIFIED_WARNING = "⚠️ Not yet checked by our team. Don't pay a deposit before you see the item or the work.";
const ONLINE_WARNING = "⚠️ Found online. Our team hasn't checked this business. Don't pay a deposit before you see the item or the work.";

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

export function help(brand: string, can: { photos?: boolean; voice?: boolean } = {}): OutboundMessage {
  const ways = [can.voice ? "send a voice note" : null, can.photos ? "send a photo of what you want" : null].filter(Boolean);
  return {
    kind: "text",
    text:
      `*How ${brand} works*\n` +
      `1. Tell me what you need and where.${ways.length ? ` You can also ${ways.join(" or ")}.` : ""}\n` +
      "2. I show businesses that can help. ✅ means our team checked them in person.\n" +
      "3. Pick one and tap *Connect me* to chat with them directly on WhatsApp.\n\n" +
      "Type *recommend* to tell us about a good business we should list, *agent* to talk to a person, or *menu* to start again.",
  };
}

export function askLocation(need: string): OutboundMessage {
  return { kind: "location_request", body: `Where should I look for *${need}*? Share your location, or type your suburb or town.` };
}

export function locationSaved(place: string): OutboundMessage {
  return { kind: "text", text: `Thanks, I'll search near *${place}*. What are you looking for?` };
}

export function results(requestId: string, hits: BusinessView[], need: string, place?: string): OutboundMessage {
  const count = hits.length === 1 ? "1 place" : `${hits.length} places`;
  const warning = hits.some((h) => h.verification !== "verified")
    ? "\n⚠️ Businesses without ✅ signed up themselves. Don't pay a deposit before you see the item or the work."
    : "";
  return {
    kind: "list",
    body: `I found ${count} for *${need}*${place ? ` near ${place}` : ""}. Tap *See options* and pick one.\n\n✅ = checked in person by our team.${warning}`,
    button: "See options",
    sections: [
      {
        title: "Businesses",
        rows: hits.map((h) => ({
          id: Ids.business(requestId, h.id),
          title: h.name,
          description: [badge(h), h.areaName, distance(h), rating(h)].filter(Boolean).join(" · "),
        })),
      },
    ],
    footer: "Type menu to start a new search",
  };
}

export function businessCard(requestId: string, b: BusinessView, prices?: PriceView): OutboundMessage {
  const details = [badge(b), b.areaName, distance(b) ? `${distance(b)} away` : null, rating(b)].filter(Boolean).join(" · ");
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
    body: `*${b.name}*\n${details}${b.description ? `\n\n${b.description}` : ""}${priceLines}${b.verification === "verified" ? "" : `\n\n${UNVERIFIED_WARNING}`}`,
    buttons,
  };
}

export function prefilledMessage(brand: string, businessName: string, refCode: string, summary: string): string {
  return `Hi ${businessName}, I found you on ${brand} (ref ${refCode}). I'm looking for: ${summary}`;
}

export function connectLink(b: BusinessView, url: string, refCode: string, fromPhoto = false): OutboundMessage {
  return {
    kind: "cta_url",
    body:
      `Tap below to chat with *${b.name}* on WhatsApp. Your message is ready, so just press send.` +
      (fromPhoto ? " Then send them your photo too." : "") +
      `\n\nReference: *${refCode}*` +
      (b.verification === "verified" ? "" : `\n\n${UNVERIFIED_WARNING}`),
    displayText: "Chat with them",
    url,
  };
}

export function noResults(requestId: string, need: string, place?: string): OutboundMessage {
  return {
    kind: "buttons",
    body:
      `I couldn't find a listed business for *${need}*${place ? ` near ${place}` : ""} yet. ` +
      "I can ask businesses nearby and message you when one can help, or a person from our team can take over.\n\n" +
      "Know a good business that does this? Type *recommend* and we'll invite them.",
    buttons: [
      { id: Ids.askAround(requestId), title: "Ask around" },
      { id: Ids.human(requestId), title: "Talk to a person" },
      { id: Ids.newSearch, title: "New search" },
    ],
  };
}

// ---------- Found online ----------

function leadLine(l: LeadView): string {
  const where = l.distanceKm != null ? `${l.areaName ?? "nearby"} · ${l.distanceKm < 1 ? "under 1 km" : `${l.distanceKm.toFixed(0)} km`}` : l.areaName;
  return ["🌐 Found online", where, l.source].filter(Boolean).join(" · ");
}

export function searchingOnline(need: string, place?: string): OutboundMessage {
  return {
    kind: "text",
    text: `Nothing is listed with us for *${need}*${place ? ` near ${place}` : ""} yet. 🌐 I'm checking online. This can take up to a minute…`,
  };
}

export function onlineResults(requestId: string, leads: LeadView[], need: string, place?: string): OutboundMessage {
  const count = leads.length === 1 ? "1 business" : `${leads.length} businesses`;
  return {
    kind: "list",
    body:
      `Nothing is listed with us for *${need}*${place ? ` near ${place}` : ""} yet, but I found ${count} online. Tap *See options*.\n\n${ONLINE_WARNING}`,
    button: "See options",
    sections: [
      {
        title: "Found online",
        rows: leads.map((l) => ({ id: Ids.onlineBusiness(requestId, l.id), title: l.name, description: leadLine(l) })),
      },
      {
        title: "More options",
        rows: [
          { id: Ids.askAround(requestId), title: "Ask around", description: "Ask businesses we know if they can help" },
          { id: Ids.human(requestId), title: "Talk to a person", description: "Someone from our team takes over" },
        ],
      },
    ],
    footer: "Type menu to start a new search",
  };
}

export function onlineCard(requestId: string, l: LeadView): OutboundMessage {
  return {
    kind: "buttons",
    body: `*${l.name}*\n${leadLine(l)}${l.description ? `\n\n${l.description}` : ""}\n\n${ONLINE_WARNING}`,
    buttons: [
      { id: Ids.onlineConnect(requestId, l.id), title: "Connect me" },
      { id: Ids.list(requestId), title: "Other options" },
      { id: Ids.askAround(requestId), title: "Ask around" },
    ],
  };
}

export function onlinePrefilledMessage(brand: string, businessName: string, summary: string): string {
  return `Hi ${businessName}, I found your business online through ${brand}. I'm looking for: ${summary}`;
}

export function onlineConnectLink(l: LeadView, url: string, fromPhoto = false): OutboundMessage {
  return {
    kind: "cta_url",
    body:
      `Tap below to chat with *${l.name}* on WhatsApp. Your message is ready, so just press send.` +
      (fromPhoto ? " Then send them your photo too." : "") +
      `\n\n${ONLINE_WARNING}`,
    displayText: "Chat with them",
    url,
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

export function askAroundStarted(count: number): OutboundMessage {
  return {
    kind: "text",
    text: `Done. I've asked ${count} business${count === 1 ? "" : "es"} and will message you here as soon as one says they can help.`,
  };
}

export function askAroundReplyToCustomer(
  requestId: string,
  business: { id: string; name: string },
  areaName: string | null,
  need: string,
): OutboundMessage {
  return {
    kind: "buttons",
    body: `Good news! *${business.name}*${areaName ? ` (${areaName})` : ""} says they can help with *${need}*.`,
    buttons: [
      { id: Ids.connect(requestId, business.id), title: "Connect me" },
      { id: Ids.business(requestId, business.id), title: "See details" },
    ],
  };
}

export function handoff(): OutboundMessage {
  return {
    kind: "text",
    text: "Okay. A person from our team will reply here soon (Monday to Saturday, 8am to 6pm). Type *menu* to go back to the assistant.",
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

export function photosNotYet(): OutboundMessage {
  return { kind: "text", text: "I can't read photos yet. Please describe what you're looking for in words." };
}

export function photoUnreadable(): OutboundMessage {
  return {
    kind: "text",
    text: "I couldn't tell what you're looking for from that photo. Please describe it in words, or send a clearer photo with a caption.",
  };
}

export function voiceNotYet(): OutboundMessage {
  return { kind: "text", text: "I can't listen to voice notes yet. Please type what you're looking for." };
}

export function voiceFailed(): OutboundMessage {
  return { kind: "text", text: "Sorry, I couldn't listen to that voice note just now. Please type your message instead." };
}

export function voiceEmpty(): OutboundMessage {
  return { kind: "text", text: "I couldn't make out what you said. Please try again somewhere quieter, or type it." };
}

/** Shown above the reply to a voice note, so a wrong transcript is easy to spot. */
export function heard(text: string): string {
  return `🎙️ I heard: “${text.length > 200 ? `${text.slice(0, 199)}…` : text}”`;
}

export function mediaTooLarge(): OutboundMessage {
  return { kind: "text", text: "That file is too large for me. Please send a smaller photo or a shorter voice note." };
}

export function mediaFailed(): OutboundMessage {
  return { kind: "text", text: "Sorry, I couldn't open that. Please try sending it again." };
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
      { id: Ids.feedback(introId, "no_reply"), title: "They didn't reply" },
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

export function noReply(requestId: string | null, businessId: string): OutboundMessage {
  const buttons = requestId ? [{ id: Ids.list(requestId), title: "Other options" }] : [];
  return {
    kind: "buttons",
    body: "Sorry they didn't reply. Would you like to try another business?",
    buttons: [...buttons, { id: Ids.report(businessId), title: "Report them" }, { id: Ids.newSearch, title: "New search" }],
  };
}

export function askReport(): OutboundMessage {
  return { kind: "text", text: 'What went wrong? Type a short note, for example "asked for a deposit and disappeared".' };
}

export function reportThanks(): OutboundMessage {
  return { kind: "text", text: "Thank you. Our team will look into it. What else can I help you find?" };
}

export function stopped(): OutboundMessage {
  return { kind: "text", text: "Okay, I won't message you unless you write to me again. Type *menu* any time to search." };
}

// ---------- Business number ----------

export function leadNotification(brand: string, refCode: string, summary: string, place?: string | null, neededBy?: string | null): OutboundMessage {
  return {
    kind: "text",
    text:
      `🔔 *New customer from ${brand}* (ref ${refCode})\nLooking for: ${summary}` +
      (place ? `\nArea: ${place}` : "") +
      (neededBy ? `\nNeeded: ${neededBy}` : "") +
      "\n\nThey'll message you on WhatsApp shortly. Businesses that reply quickly show higher in results.",
  };
}

export function askAroundToBusiness(askId: string, need: string, place?: string | null, neededBy?: string | null): OutboundMessage {
  return {
    kind: "buttons",
    body: `🔎 A customer${place ? ` near ${place}` : ""} is looking for: *${need}*${neededBy ? ` (needed ${neededBy})` : ""}.\n\nCan you help?`,
    buttons: [
      { id: Ids.askAroundYes(askId), title: "Yes, I can help" },
      { id: Ids.askAroundNo(askId), title: "No" },
    ],
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

export function regNoCategory(): OutboundMessage {
  return {
    kind: "text",
    text: 'I couldn\'t tell which category fits. Please describe it differently, for example "we repair phones" or "we sell building materials".',
  };
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
    text: `You're listed! Customers can now find *${name}*.\n\nA field agent may visit to verify you, and verified businesses show first. Type *menu* any time for your options.`,
  };
}

export function regCancelled(): OutboundMessage {
  return { kind: "text", text: "Registration cancelled. Type *register* when you're ready." };
}

export function bizMenu(b: { name: string; status: string; verification: string }, ownsSeveral: boolean): OutboundMessage {
  const rows: { id: string; title: string; description?: string }[] = [
    { id: Ids.summary, title: "My summary", description: "Searches and customers this week" },
    { id: Ids.editWhat, title: "Update what I sell", description: "Description and categories" },
    { id: Ids.priceList, title: "Add price list photo", description: "Customers see your items and prices" },
    { id: Ids.editArea, title: "Update location", description: "Where customers find you" },
    b.status === "paused"
      ? { id: Ids.resume, title: "Resume listing", description: "Show me to customers again" }
      : { id: Ids.pause, title: "Pause listing", description: "Hide me from customers for now" },
    { id: Ids.remove, title: "Remove listing" },
    { id: Ids.register, title: "Add another business" },
  ];
  if (ownsSeveral) rows.push({ id: Ids.switchBusiness, title: "Switch business", description: "Manage one of your other listings" });
  return {
    kind: "list",
    body: `*${b.name}*\n${b.verification === "verified" ? "✅ Verified" : "Not yet verified"} · ${b.status === "paused" ? "Paused" : "Live"}\n\nWhat would you like to do?`,
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
      { id: Ids.editWhat, title: "Change it" },
    ],
  };
}

export function listingUpdated(name: string): OutboundMessage {
  return { kind: "text", text: `Done, *${name}* is updated. Type *menu* for your options.` };
}

export function askPriceListPhoto(): OutboundMessage {
  return {
    kind: "text",
    text: "Send a photo of your price list, menu or price board. Take it straight on, in good light, so every price is readable. (Type *cancel* to stop.)",
  };
}

export function priceListUnreadable(): OutboundMessage {
  return {
    kind: "text",
    text: "I couldn't read items and prices from that photo. Please send a clearer photo, taken straight on in good light, or type *cancel*.",
  };
}

export function priceListRead(businessName: string, items: { name: string; price: string | null }[]): OutboundMessage {
  const shown = items.slice(0, 10).map((i) => `• ${i.name}${i.price ? `: ${i.price}` : ""}`);
  const more = items.length > shown.length ? `\n…and ${items.length - shown.length} more` : "";
  return {
    kind: "buttons",
    body:
      `I read ${items.length} item${items.length === 1 ? "" : "s"} from your price list:\n${shown.join("\n")}${more}\n\n` +
      `Save them to *${businessName}*? Customers searching for these items will find you.`,
    buttons: [
      { id: Ids.priceSave, title: "Save prices" },
      { id: Ids.priceRetry, title: "Try another photo" },
      { id: Ids.menu, title: "Cancel" },
    ],
  };
}

export function priceListSaved(businessName: string, count: number): OutboundMessage {
  return {
    kind: "text",
    text: `Saved! ${count} item${count === 1 ? "" : "s"} from your price list are now on *${businessName}*. Send a new photo whenever your prices change.`,
  };
}

export function bizPhotosUnavailable(): OutboundMessage {
  return { kind: "text", text: "I can't read photos right now. Please try again later, or type *menu* for your options." };
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

export function bizNoListing(): OutboundMessage {
  return { kind: "text", text: "You don't have a listing yet. Type *register* to list your business." };
}

export function askAroundThanks(): OutboundMessage {
  return { kind: "text", text: "Thanks! We've told the customer. They'll message you directly." };
}

export function askAroundNoThanks(): OutboundMessage {
  return { kind: "text", text: "No problem, thanks for letting us know." };
}

export function askAroundAlreadyAnswered(): OutboundMessage {
  return { kind: "text", text: "Thanks, you've already answered this one." };
}

export function notYourRequest(): OutboundMessage {
  return { kind: "text", text: "This request was sent to a different business." };
}
