import { remember } from "../ai/phrasebook.js";
import type { RequestInterpretation } from "../ai/types.js";
import type { ReaderContext, ReadingSummary, Understanding, UnderstoodBy } from "../ai/understanding.js";
import { one } from "../db/client.js";
import { adjustResponseScore, businessesOwnedBy, getBusiness, recordRating, type Business } from "../directory/businesses.js";
import { haversineKm, type Area } from "../directory/gazetteer.js";
import { createIntroduction, getIntroduction, waMeLink, type Introduction } from "../directory/introductions.js";
import { priceOf, productQuery, productsOf, searchProducts, wordsToMatch, type ProductHit, type ProductMatch, type ProductQuery } from "../directory/products.js";
import { createRecommendation } from "../directory/recommendations.js";
import { fileReport, reportsSince } from "../directory/reports.js";
import { searchBusinesses, searchRelated, type BusinessHit } from "../directory/search.js";
import { mergeSuppliers, type Supplier } from "../directory/suppliers.js";
import { trackRecord } from "../directory/trust.js";
import type { Category } from "../directory/taxonomy.js";
import { eraseContact } from "../privacy.js";
import { containsPhrase, normalizeMessage, normalizeText, normalizeZimPhone } from "../text.js";
import { whenTeamReplies } from "../time.js";
import type { OutboundMessage } from "../whatsapp/outbound.js";
import { setAlerts } from "./alerts.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import type { BusinessView, ListedProduct, Need, PriceView } from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import {
  createRequest,
  flagRequest,
  getRequest,
  otherSide,
  recordAnswer,
  recordQuestion,
  saveResults,
  setConsent,
  setRequestStatus,
  type RequestRow,
} from "./store.js";

/** A "Did you mean…?" question waiting for the customer's answer. */
interface Choice {
  /** The clarifications row, to record what they picked. */
  id: string;
  raw: string;
  interpretation: RequestInterpretation;
  options: string[];
  signature: string | null;
  reading: ReadingSummary;
}

export interface CustomerState {
  stage?:
    | "awaiting_consent"
    | "awaiting_area"
    | "awaiting_choice"
    | "awaiting_report"
    | "handoff"
    | "rec_name"
    | "rec_what"
    | "rec_area"
    | "rec_phone";
  /** First message, kept while we ask for consent. */
  pendingText?: string;
  /** A request waiting for the customer's location. */
  pending?: { raw: string; interpretation: RequestInterpretation; by: UnderstoodBy; reading?: ReadingSummary };
  /** A request waiting for the customer to say which category they mean. */
  choice?: Choice;
  lastRequestId?: string;
  lastQuery?: string;
  /** Where they said they are, and when (ISO): used for later searches for a while (LOCATION_TTL_MS). */
  location?: Place & { at?: string };
  /** When they last wrote while a question of ours waited for its answer (ISO); see STAGE_TTL_MS. */
  stageAt?: string;
  reportBusinessId?: string;
  /** A recommendation being written. */
  rec?: { name?: string; what?: string; areaText?: string | null; areaId?: number | null };
  /** We already asked them to say it differently; next time a person takes over. */
  unclear?: boolean;
  /**
   * A business owner looking for supplies, on the business side (see business.ts): searches
   * find businesses that sell wholesale, and suppliers are told which business is asking.
   */
  buying?: { businessId: string; name: string };
}

type T = Turn<CustomerState>;

interface Place {
  areaId: number | null;
  lat: number;
  lng: number;
  label: string;
}

const RECOMMEND_WORDS = ["recommend", "recommend a business", "suggest a business", "recommendation"];
/**
 * Clear signs the assistant keeps getting it wrong, in English, Shona and Ndebele: a person takes
 * over straight away. Draft phrases: native speakers should check the Shona and Ndebele ones.
 */
const FRUSTRATED = [
  "you dont understand", "you do not understand", "you are not helping", "youre not helping", "this is not helping",
  "not helpful", "useless", "stupid", "not what i asked", "wrong answer", "are you a robot", "are you a bot",
  "hauna kunzwisisa", "haunzwisise", "hazvina basa", "hazvisi izvo",
  "awuzwisisi", "akuzwisisi", "akusizo", "akulancedo",
];

const ALERTS_OFF = ["alerts off", "stop alerts", "no alerts", "no more alerts", "turn off alerts"];
/** Agreeing in words, once they've seen the notice, works like the *I agree* button. */
const AGREE = ["i agree", "agree", "yes i agree", "ok i agree", "i accept", "accept", "yes", "ok", "okay", "hongu", "ehe", "ndinobvuma", "yebo", "ngiyavuma"];
/** "Where should I look?" answered with "anywhere": the search runs without a place. */
const ANYWHERE = ["anywhere", "any where", "everywhere", "any place", "anyplace", "all over", "anywhere in zimbabwe", "all of zimbabwe", "nationwide", "countrywide"];
/**
 * A question we asked (where, which one, what went wrong, a recommendation's details) waits this
 * long after their last message; after that a message is a fresh start, never a late answer.
 */
const STAGE_TTL_MS = 60 * 60_000;
const LAPSING = new Set<CustomerState["stage"]>(["awaiting_area", "awaiting_choice", "awaiting_report", "rec_name", "rec_what", "rec_area", "rec_phone"]);
/** A place they gave is used for their other searches that day, not for ever. */
const LOCATION_TTL_MS = 12 * 3600_000;
/** Words around a place name in an answer to "Where should I look?": "I'm in Avondale, Harare". */
const PLACE_WORDS = new Set([
  "in", "at", "near", "around", "by", "from", "the", "my", "our", "i", "im", "am", "we", "are", "is", "its", "it", "me",
  "area", "suburb", "town", "city", "location", "place", "side", "here", "live", "stay", "staying", "living", "based",
  "please", "ok", "okay", "thanks", "thank", "you", "and", "zimbabwe", "ndiri", "ndinogara", "tiri", "ngise", "ngihlala",
]);
/** A typed answer to our follow-up, when one is waiting: what the buttons would have said. */
const FOLLOW_UP_WORDS: [string, string[]][] = [
  ["sorted", ["yes", "yes sorted", "sorted", "yes thanks", "yes thank you", "yes i did", "i did", "yes i got it", "got it", "it worked", "yes it worked", "hongu", "yebo", "ehe"]],
  ["not_yet", ["not yet", "no not yet", "still waiting", "not yet sorted", "i havent yet", "havent yet"]],
  ["failed", ["no", "it didnt work out", "didnt work out", "it didnt work", "no it didnt", "they didnt reply", "no reply", "kwete", "aiwa", "hatshi"]],
];
/** "No" to "What's their number?" means they don't have it, not "cancel the recommendation". */
const NO_PHONE = ["skip", "dont know", "i dont know", "no idea", "no", "none", "nope", "no number", "not sure", "dont have it", "i dont have it", "dont have", "i dont have", "i dont have their number", "unknown"];
/** A product's code as its page on our website shows it. */
export const PRODUCT_CODE = /\bP-([0-9a-f]{8})\b/i;

export const ERASE_WORDS = [
  "delete my data",
  "delete my information",
  "delete my info",
  "delete my details",
  "delete my account",
  "erase my data",
  "remove my data",
  "forget me",
];

export async function handleCustomerTurn(t: T): Promise<void> {
  const { contact, inbound, state, svc } = t;
  if (contact.is_blocked) return;
  // A reaction to one of our messages needs no answer.
  if (inbound.content.type === "unsupported" && inbound.content.rawType === "reaction") return;
  lapseStaleStage(t);
  try {
    await customerTurn(t);
  } finally {
    // A question of ours keeps waiting while they write; STAGE_TTL_MS counts from their last message.
    state.stageAt = state.stage ? svc.now().toISOString() : undefined;
  }
}

/** A question left unanswered for a while is dropped: "Avondale" a day later is a new request. */
function lapseStaleStage(t: T): void {
  const { state, svc } = t;
  if (!state.stage || !LAPSING.has(state.stage) || !state.stageAt) return;
  if (svc.now().getTime() - Date.parse(state.stageAt) < STAGE_TTL_MS) return;
  resetSearch(state);
}

async function customerTurn(t: T): Promise<void> {
  const { contact, inbound, state } = t;

  // Deleting their data works at any point, even before consent or while a person is handling the chat.
  const c0 = inbound.content;
  if (c0.type === "text" && isCommand(c0.text, ERASE_WORDS)) return t.reply(copy.eraseConfirm());
  if ((c0.type === "button_reply" || c0.type === "list_reply") && (c0.id === Ids.eraseYes || c0.id === Ids.eraseNo)) {
    return eraseAnswer(t, c0.id === Ids.eraseYes);
  }

  if (state.stage === "handoff") return duringHandoff(t);

  if (!contact.consent_at) return consentGate(t);

  // Written from one of our product cards: the store that lists it.
  if (inbound.referredProduct) {
    resetSearch(state);
    return askedAboutProduct(t, inbound.referredProduct.retailerId);
  }

  const c = inbound.content;
  switch (c.type) {
    case "order":
      // A cart from our product cards: stores sell directly, so the store is what they need.
      resetSearch(state);
      return askedAboutProduct(t, c.items[0]?.retailerId ?? "", copy.ordersGoToStores());
    case "text":
      return onText(t, c.text);
    case "button_reply":
    case "list_reply":
      return onAction(t, c.id);
    case "location":
      return onLocation(t, c.lat, c.lng);
    // Typed messages only, for now: voice notes, photos, stickers, videos and documents aren't read.
    case "image":
    case "audio":
    case "unsupported":
      return t.reply(copy.typeInstead());
    default:
      return t.reply(copy.help(t.svc.config.brandName));
  }
}

/**
 * A person from the team is handling this chat, so the assistant stays quiet. "menu" brings it
 * back; "stop" and "alerts off" still work, and so do answers to our follow-ups and alerts (the
 * chat stays with the team).
 */
async function duringHandoff(t: T): Promise<void> {
  const { inbound, state } = t;
  const c = inbound.content;
  if (c.type === "text") {
    if (isCommand(c.text, ["menu", "bot", "assistant"])) {
      state.stage = undefined;
      return t.reply(copy.welcomeBack());
    }
    if (isCommand(c.text, ["stop", "unsubscribe", ...ALERTS_OFF])) return onText(t, c.text);
    return;
  }
  if (c.type === "button_reply" || c.type === "list_reply") {
    const { action } = parseAction(c.id);
    if (action !== "fb" && action !== "rate" && action !== "alerts") return;
    await onAction(t, c.id);
    if (!state.stage) state.stage = "handoff";
  }
}

async function consentGate(t: T): Promise<void> {
  const { contact, inbound, state, svc } = t;
  const c = inbound.content;
  // The button, or agreeing in words once they've seen the notice ("I agree", "yes", "ndinobvuma").
  const typed = c.type === "text" && state.stage === "awaiting_consent" && isCommand(c.text, AGREE);
  if ((c.type === "button_reply" && c.id === Ids.consent) || typed) {
    await setConsent(svc.db, contact.id);
    contact.consent_at = svc.now();
    const { pendingText } = state;
    state.stage = undefined;
    state.pendingText = undefined;
    // Their first message is the request, unless it was only "ok" or "yes".
    if (pendingText && !isCommand(pendingText, AGREE)) return onText(t, pendingText);
    return t.reply(copy.askWhatYouNeed(contact.profile_name));
  }
  if (!state.pendingText && c.type === "text") state.pendingText = c.text.slice(0, 500);
  state.stage = "awaiting_consent";
  await t.reply(copy.consent(svc.config.brandName, svc.config.privacyUrl, contact.profile_name));
}

async function onText(t: T, text: string): Promise<void> {
  const { svc, state, contact } = t;
  const raw = text.trim();
  if (!raw) return;

  if (isCommand(raw, ["stop", "unsubscribe"])) {
    resetSearch(state);
    // "I won't message you unless you write to me again": no alerts, and no follow-ups (see followups.ts).
    await setAlerts(svc.db, contact.id, false, svc.now());
    await svc.db.query("UPDATE contacts SET stopped_at = $2 WHERE id = $1", [contact.id, svc.now()]);
    return t.reply(copy.stopped());
  }
  if (isCommand(raw, ALERTS_OFF)) {
    await setAlerts(svc.db, contact.id, false, svc.now());
    return t.reply(copy.alertsOff());
  }
  if (isCommand(raw, ["alerts on", "alerts", "turn on alerts"])) {
    await setAlerts(svc.db, contact.id, true, svc.now());
    return t.reply(copy.alertsOn());
  }
  // A product's code, from its page on our website ("P-3f2a9c1e").
  const code = PRODUCT_CODE.exec(raw);
  if (code) {
    resetSearch(state);
    return askedAboutProduct(t, code[1]!.toLowerCase());
  }
  if (isCommand(raw, ["menu", "start", "restart", "new search"])) {
    resetSearch(state);
    return t.reply(copy.askWhatYouNeed(contact.profile_name));
  }
  if (isCommand(raw, ["help"])) return t.reply(copy.help(svc.config.brandName));
  if (isCommand(raw, RECOMMEND_WORDS)) {
    resetSearch(state);
    state.stage = "rec_name";
    state.rec = {};
    return t.reply(copy.recAskName());
  }

  if (state.stage === "awaiting_report" && state.reportBusinessId) {
    const businessId = state.reportBusinessId;
    state.stage = undefined;
    state.reportBusinessId = undefined;
    const filed = await fileReport(svc.db, { contactId: contact.id, businessId, reason: raw }, svc.config.limits.reportsToPause);
    if (filed?.paused) {
      svc.alerts.send(`paused:${businessId}`, `${filed.businessName} was paused after reports from several customers who contacted them. Review it under Reports.`);
    }
    return t.reply(copy.reportThanks());
  }

  if (state.stage?.startsWith("rec_")) return continueRecommendation(t, raw);

  // "You don't understand": don't make them try again, and let the team check what went wrong.
  const said = normalizeText(raw);
  if (FRUSTRATED.some((p) => containsPhrase(said, p))) {
    if (state.lastRequestId) await flagRequest(svc.db, state.lastRequestId);
    resetSearch(state);
    return startHandoff(t, null, raw, copy.frustratedHandoff(whenTeamReplies(svc.now(), svc.config.teamHours)));
  }

  if (state.stage === "awaiting_area" && state.pending) {
    const pending = state.pending;
    const anywhere = isCommand(raw, ANYWHERE);
    const place = anywhere ? undefined : placeAnswer(t, raw);
    if (anywhere || place) return answerWhere(t, pending, place);
    // More than a place: a new request ("a plumber in Avondale"), or a place we don't know yet.
    // A reading the engine isn't sure of (it would ask "Which of these?") is taken for a place.
    const understood = await svc.understanding.understand(raw, readerContext(t));
    const { intent, category_slug } = understood.interpretation;
    const newRequest = !understood.options?.length && (intent === "search" ? !!category_slug : intent !== "unclear");
    if (!newRequest) {
      const area = svc.gazetteer.match(raw, { fuzzy: true });
      if (area) return answerWhere(t, pending, placeOf(area));
      // The request waits: they can type a place we know, share their location, or say "anywhere".
      return t.reply(copy.unknownPlace());
    }
    state.stage = undefined;
    state.pending = undefined;
    return handleInterpretation(t, raw, understood.interpretation, understood.by, understood.reading);
  }

  if (state.stage === "awaiting_choice" && state.choice) {
    const choice = state.choice;
    state.stage = undefined;
    state.choice = undefined;
    // They may answer in words ("hire", "yes"). If that settles it, it's their pick; otherwise it's a new request.
    const picked = pickInWords(t, raw, choice);
    if (picked !== undefined) return answerChoice(t, choice, picked);
  }

  // "Yes" or "not yet" typed under our follow-up, instead of tapping a button.
  const answer = FOLLOW_UP_WORDS.find(([, words]) => isCommand(raw, words))?.[0];
  if (answer) {
    const asked = await one<{ id: string }>(
      svc.db,
      `SELECT id FROM introductions WHERE contact_id = $1 AND outcome IS NULL AND followed_up_at > $2
        ORDER BY followed_up_at DESC LIMIT 1`,
      [contact.id, new Date(svc.now().getTime() - 3 * 24 * 3600_000)],
    );
    if (asked) return feedback(t, asked.id, answer);
  }

  // Local engine first; then the phrasebook, a question for the customer, and Claude only for what's left.
  const understood = await svc.understanding.understand(raw, readerContext(t));
  if (understood.options?.length) return askWhichOne(t, raw, understood);
  return handleInterpretation(t, raw, understood.interpretation, understood.by, understood.reading);
}

function readerContext(t: T): ReaderContext {
  const { svc, state, contact } = t;
  return {
    taxonomy: svc.taxonomy,
    gazetteer: svc.gazetteer,
    lexicon: svc.lexicon,
    classifier: svc.classifier,
    previousRequest: state.lastQuery,
    contactId: contact.id,
  };
}

/**
 * Several categories fit, or the words that decided it haven't been checked by a native speaker
 * yet: ask which one they mean. Their answer is remembered for this wording, so the next
 * customer who writes the same thing isn't asked.
 */
async function askWhichOne(t: T, raw: string, understood: Understanding): Promise<void> {
  const { svc, state, contact } = t;
  const options = (understood.options ?? []).map((slug) => svc.taxonomy.get(slug)).filter((c) => c !== undefined);
  if (!options.length) return handleInterpretation(t, raw, understood.interpretation, understood.by, understood.reading);
  const slugs = options.map((c) => c.slug);
  const id = await recordQuestion(svc.db, { contactId: contact.id, signature: understood.signature, options: slugs });
  state.stage = "awaiting_choice";
  state.choice = { id, raw, interpretation: understood.interpretation, options: slugs, signature: understood.signature, reading: understood.reading };
  return t.reply(copy.didYouMean(options.map((c) => ({ slug: c.slug, name: c.name, short: c.short }))));
}

const YES = ["yes", "yeah", "yep", "yes please", "correct", "hongu", "ehe", "ehoyi", "yebo"];
const NO = ["no", "nope", "neither", "none", "aiwa", "kwete", "hatshi", "something else"];

/** A typed answer to "Did you mean…?": a category slug, "" for none of them, or undefined for a new request. */
function pickInWords(t: T, raw: string, choice: Choice): string | undefined {
  const [only] = choice.options;
  if (isCommand(raw, YES) && choice.options.length === 1 && only) return only;
  if (isCommand(raw, NO)) return "";
  const said = t.svc.keywords.read(raw, readerContext(t)).candidates.filter((c) => choice.options.includes(c));
  return said.length === 1 ? said[0] : undefined;
}

/** The customer picked a category (or "" for none of them). */
async function answerChoice(t: T, choice: Choice, slug: string): Promise<void> {
  const { svc } = t;
  const category = slug && choice.options.includes(slug) ? svc.taxonomy.get(slug) : undefined;
  await recordAnswer(svc.db, choice.id, category?.slug ?? "other");
  if (!category) return somethingElse(t, choice);
  const interpretation: RequestInterpretation = {
    ...choice.interpretation,
    intent: "search",
    category_slug: category.slug,
    clarifying_question: null,
  };
  if (choice.signature) await remember(svc.db, choice.signature, interpretation, "customer");
  return handleInterpretation(t, choice.raw, interpretation, "customer", choice.reading);
}

async function chooseMeaning(t: T, slug: string): Promise<void> {
  const { state, contact } = t;
  const choice = state.choice;
  if (state.stage !== "awaiting_choice" || !choice) return t.reply(copy.askWhatYouNeed(contact.profile_name));
  state.stage = undefined;
  state.choice = undefined;
  return answerChoice(t, choice, slug);
}

/**
 * None of the options fit. Claude reads the request if it can, told what's ruled out; if it
 * can't, we ask the customer to say it differently, and a person takes over after that.
 */
async function somethingElse(t: T, choice: Choice): Promise<void> {
  const understood = await t.svc.understanding.understand(choice.raw, { ...readerContext(t), noAsk: true, exclude: choice.options });
  if (understood.by !== "fallback" && understood.interpretation.category_slug) {
    return handleInterpretation(t, choice.raw, understood.interpretation, understood.by, understood.reading);
  }
  const interpretation = { ...understood.interpretation, clarifying_question: copy.sayItDifferently() };
  return notUnderstood(t, choice.raw, interpretation, "fallback", understood.reading);
}

/** What to do with a request once we know what it means, whether they typed it or picked it from our question. */
async function handleInterpretation(
  t: T,
  raw: string,
  interpretation: RequestInterpretation,
  by: UnderstoodBy,
  reading?: ReadingSummary,
): Promise<void> {
  const { svc, state, contact } = t;
  switch (interpretation.intent) {
    case "greeting":
      return t.reply(copy.askWhatYouNeed(contact.profile_name));
    case "help":
      return t.reply(copy.help(svc.config.brandName));
    case "human":
      return startHandoff(t, null, raw);
    case "blocked":
      await createRequest(svc.db, {
        contactId: contact.id,
        rawText: raw,
        interpretation,
        categorySlug: interpretation.category_slug,
        query: interpretation.query,
        status: "closed",
        understoodBy: by,
        reading,
      });
      return t.reply(copy.blocked());
    case "out_of_scope":
      return t.reply(copy.outOfScope());
    case "unclear":
      return notUnderstood(t, raw, interpretation, by, reading);
    case "search":
      break;
  }

  const category = svc.taxonomy.get(interpretation.category_slug);
  if (category?.risk === "blocked") return t.reply(copy.blocked());
  if (category?.risk === "restricted") return t.reply(copy.restricted(category.name));
  // No category from anyone (local engine, phrasebook or Claude): we don't know what they want.
  if (!category && (by === "fallback" || !interpretation.query || interpretation.clarifying_question)) {
    return notUnderstood(t, raw, interpretation, by, reading);
  }
  state.unclear = undefined;

  const area = (interpretation.area && svc.gazetteer.match(interpretation.area)) || svc.gazetteer.match(raw);
  const place: Place | undefined = area ? placeOf(area) : savedPlace(t);
  if (!place && category?.needsLocation !== false) {
    state.stage = "awaiting_area";
    state.pending = { raw, interpretation, by, reading };
    return t.reply(copy.askLocation(need(interpretation, category, by)));
  }
  if (area && place) rememberPlace(t, place);
  return runSearch(t, raw, interpretation, by, category?.needsLocation === false && !area ? undefined : place, reading);
}

/** Ask them to put it differently once; if we still can't tell, a person takes over. */
async function notUnderstood(
  t: T,
  raw: string,
  interpretation: RequestInterpretation,
  by: UnderstoodBy,
  reading?: ReadingSummary,
): Promise<void> {
  const { svc, state, contact } = t;
  const second = !!state.unclear;
  // Recorded either way, so the wording shows up in the Vocabulary screen for the team to teach.
  const request = await createRequest(svc.db, {
    contactId: contact.id,
    rawText: raw,
    interpretation,
    categorySlug: null,
    query: interpretation.query,
    status: second ? "handoff" : "no_results",
    understoodBy: by,
    reading,
  });
  if (!second) {
    state.unclear = true;
    return t.reply(copy.clarify(interpretation.clarifying_question));
  }
  state.unclear = undefined;
  state.stage = "handoff";
  await setRequestStatus(svc.db, request.id, "handoff", 0, "none");
  svc.log.info({ contactId: contact.id, requestId: request.id }, "Not understood twice; handed over to a person");
  return t.reply(copy.notUnderstoodHandoff(whenTeamReplies(svc.now(), svc.config.teamHours)));
}

async function onLocation(t: T, lat: number, lng: number): Promise<void> {
  const { svc, state } = t;
  const area = svc.gazetteer.nearest(lat, lng);
  if (state.stage === "rec_area") return setRecommendationArea(t, area?.name ?? null, area?.id ?? null);
  const place = { areaId: area?.id ?? null, lat, lng, label: area?.name ?? "your location" };
  if (state.stage === "awaiting_area" && state.pending) return answerWhere(t, state.pending, place);
  rememberPlace(t, place);
  return t.reply(copy.locationSaved(place.label));
}

/** The answer to "Where should I look?": the waiting request runs there (or anywhere, without a place). */
async function answerWhere(t: T, pending: NonNullable<CustomerState["pending"]>, place: Place | undefined): Promise<void> {
  t.state.stage = undefined;
  t.state.pending = undefined;
  if (place) rememberPlace(t, place);
  return runSearch(t, pending.raw, pending.interpretation, pending.by, place, pending.reading);
}

/**
 * A place, when that's all they wrote ("Avondale", "I'm in Hillside, Bulawayo"), or one word or
 * two that are a misspelt place ("Mabelrein"). Anything more may be a new request.
 */
function placeAnswer(t: T, raw: string): Place | undefined {
  const { gazetteer } = t.svc;
  const words = normalizeMessage(raw).split(" ").filter(Boolean);
  const places = gazetteer.locateAll(words);
  const named = new Set(places.flatMap((p) => Array.from({ length: p.end - p.start }, (_, k) => p.start + k)));
  const rest = words.filter((w, i) => !named.has(i) && !PLACE_WORDS.has(w));
  if (places[0] && !rest.length) return placeOf(places[0].area);
  if (!places.length && rest.length && rest.length <= 2) {
    const area = gazetteer.match(rest.join(" "), { fuzzy: true });
    if (area) return placeOf(area);
  }
  return undefined;
}

function placeOf(area: Area): Place {
  return { areaId: area.id, lat: area.lat, lng: area.lng, label: area.name };
}

function rememberPlace(t: T, place: Place): void {
  t.state.location = { ...place, at: t.svc.now().toISOString() };
}

/**
 * Where they said they were, if it was recently enough to still be true. A business looking for
 * supplies searches near itself (see business.ts) for as long as the search goes on.
 */
function savedPlace(t: T): Place | undefined {
  const saved = t.state.location;
  if (!saved) return undefined;
  const recent = !!saved.at && t.svc.now().getTime() - Date.parse(saved.at) <= LOCATION_TTL_MS;
  if (!recent && !t.state.buying) return undefined;
  return { areaId: saved.areaId, lat: saved.lat, lng: saved.lng, label: saved.label };
}

/**
 * Suppliers for a request: businesses that list a matching product, and those in its category,
 * read live (a price changed on the dashboard a moment ago is the price in this reply). If none are
 * nearby, suppliers in related categories (a gadget nobody lists goes to our electronics shops). If
 * there are none of those either, a person from the team takes over straight away. Related-only and
 * handed-over requests are supply gaps for the team.
 */
async function runSearch(
  t: T,
  raw: string,
  interpretation: RequestInterpretation,
  by: UnderstoodBy,
  place?: Place,
  reading?: ReadingSummary,
): Promise<void> {
  const { svc, state, contact } = t;
  const category = svc.taxonomy.get(interpretation.category_slug);
  const buyer = state.buying;
  const request = await createRequest(svc.db, {
    contactId: contact.id,
    rawText: raw,
    interpretation,
    categorySlug: category?.slug ?? null,
    query: interpretation.query,
    areaId: place?.areaId ?? null,
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    understoodBy: by,
    reading,
    buyerBusinessId: buyer?.businessId ?? null,
  });
  state.lastRequestId = request.id;
  state.lastQuery = raw;
  const what: Need = { ...need(interpretation, category, by), trade: !!buyer };
  const search = {
    lat: place?.lat,
    lng: place?.lng,
    limit: svc.config.maxResults,
    minVerified: svc.config.minVerifiedResults,
    // A business looking for supplies sees wholesalers, and never its own listings.
    trade: buyer ? ("wholesale" as const) : ("retail" as const),
    excludeIds: buyer ? (await businessesOwnedBy(svc.db, contact.id)).map((b) => b.id) : [],
  };

  const products = productQueryFor(t, interpretation, raw);
  const text = interpretation.query || raw;
  const found = await findSuppliers(t, { ...search, category, text, products });
  const budget = interpretation.budget_usd;
  if (found.suppliers.length) {
    await saveResults(svc.db, request.id, found.suppliers.map((s) => ({ businessId: s.id, offeringId: s.product?.id })));
    await setRequestStatus(svc.db, request.id, "answered", found.suppliers.length, "exact", found.productMatches);
    await t.reply(resultsMessage(t, request.id, found.suppliers, what, place?.label, category, { budget }));
    return sendProductCards(t, found.suppliers, what, products);
  }

  // No wholesaler has it: a business gets the retail stores in that line of business instead.
  if (buyer) {
    const retail = await findSuppliers(t, { ...search, trade: "retail", category, text, products });
    if (retail.suppliers.length) {
      await saveResults(svc.db, request.id, retail.suppliers.map((s) => ({ businessId: s.id, offeringId: s.product?.id })));
      await setRequestStatus(svc.db, request.id, "answered", retail.suppliers.length, "retail", retail.productMatches);
      await t.reply(resultsMessage(t, request.id, retail.suppliers, what, place?.label, category, { budget, retailInstead: true }));
      return sendProductCards(t, retail.suppliers, what, products);
    }
  }

  const related = category ? await searchRelated(svc.db, svc.taxonomy, { ...search, categorySlug: category.slug }) : [];
  if (category && related.length) {
    await saveResults(svc.db, request.id, related.map((h) => ({ businessId: h.id })));
    await setRequestStatus(svc.db, request.id, "answered", related.length, "related", 0);
    return t.reply(copy.relatedResults(request.id, related, what, relatedLabel(t, category), place?.label));
  }

  await setRequestStatus(svc.db, request.id, "handoff", 0, "none", 0);
  state.stage = "handoff";
  svc.log.info({ contactId: contact.id, requestId: request.id }, "No supplier found; handed over to a person");
  return t.reply(copy.noSupplierHandoff(what, place?.label, whenTeamReplies(svc.now(), svc.config.teamHours)));
}

async function onAction(t: T, id: string): Promise<void> {
  const { svc, state, contact } = t;
  const { action, args } = parseAction(id);
  switch (action) {
    case "consent":
      return t.reply(copy.askWhatYouNeed(contact.profile_name));
    case "biz":
      return showBusiness(t, args[0] ?? "", args[1] ?? "");
    case "con":
      return connect(t, args[0] ?? "", args[1] ?? "");
    case "list":
      return reshowResults(t, args[0] ?? "");
    case "human":
      return startHandoff(t, args[0] || null, null);
    case "mean":
      return chooseMeaning(t, args[0] ?? "");
    case "notit":
      return notWhatTheyAsked(t, args[0] ?? "");
    case "new":
      resetSearch(state);
      return t.reply(copy.askWhatYouNeed(contact.profile_name));
    case "rep":
      return startReport(t, args[0] ?? "");
    case "fb":
      return feedback(t, args[0] ?? "", args[1] ?? "");
    case "rate":
      return rate(t, args[0] ?? "", Number(args[1]));
    case "alerts":
      await setAlerts(svc.db, contact.id, false, svc.now());
      return t.reply(copy.alertsOff());
    default:
      return t.reply(copy.help(svc.config.brandName));
  }
}

async function showBusiness(t: T, requestId: string, businessId: string): Promise<void> {
  const { svc } = t;
  const business = await getBusiness(svc.db, businessId);
  if (!business || business.status !== "active") return t.reply(copy.noLongerAvailable());
  const request = await ownRequest(t, requestId);
  const prices = request ? await pricesFor(t, business.id, request) : undefined;
  const record = await trackRecord(svc.db, business.id);
  const view = { ...viewOf(t, business, request), verifiedAt: business.verified_at ? new Date(business.verified_at) : null, record };
  return t.reply(copy.businessCard(request?.id ?? "", view, prices));
}

/** The business's products that match what the customer asked for, read now. */
async function pricesFor(t: T, businessId: string, request: RequestRow): Promise<PriceView | undefined> {
  const query = productQueryFor(t, request.interpretation, request.raw_text, request.query);
  const matches = await productsOf(t.svc.db, businessId, query, 3).catch((err: unknown) => {
    t.svc.log.error({ err: String(err), businessId }, "Product match for a card failed");
    return [];
  });
  return matches.length ? { items: matches.map((m) => listed(t, m)) } : undefined;
}

async function connect(t: T, requestId: string, businessId: string): Promise<void> {
  const { svc, contact } = t;
  const business = await getBusiness(svc.db, businessId);
  if (!business || business.status !== "active") return t.reply(copy.noLongerAvailable());
  const request = await ownRequest(t, requestId);
  // "Connect me" tapped again (or the turn replayed after a crash): the same link. The business was
  // told and the follow-up is booked already.
  const earlier = request
    ? await one<Introduction>(
        svc.db,
        `SELECT * FROM introductions WHERE contact_id = $1 AND request_id = $2 AND business_id = $3
            AND outcome IS NULL AND created_at > $4
          ORDER BY created_at DESC LIMIT 1`,
        [contact.id, request.id, business.id, new Date(svc.now().getTime() - 24 * 3600_000)],
      )
    : undefined;
  const intro = earlier ?? (await createIntroduction(svc.db, { requestId: request?.id ?? null, contactId: contact.id, businessId: business.id }));
  if (request) await setRequestStatus(svc.db, request.id, "connected");

  const summary = truncate(request?.raw_text ?? "your products or services", 160);
  const brand = svc.config.brandName;
  const view = viewOf(t, business, request);
  // A business looking for supplies says which business is asking.
  const buyer = request?.buyer_business_id ? await getBusiness(svc.db, request.buyer_business_id) : undefined;
  const prefilled = buyer
    ? copy.prefilledTradeMessage(brand, business.name, buyer.name, intro.ref_code, summary)
    : copy.prefilledMessage(brand, business.name, intro.ref_code, summary);
  const link = waMeLink(business.phone, prefilled);
  await t.reply(copy.connectLink(view, link, intro.ref_code));
  if (earlier) return;

  const place = request?.area_id != null ? svc.gazetteer.get(request.area_id)?.name : null;
  const neededBy = request?.interpretation?.needed_by ?? null;
  // The customer's own message carries the reference, so by default the business only hears from
  // us while its window is open (free). LEAD_NOTICES=always pays for a template otherwise.
  await svc.messenger.notify(
    "business",
    business.phone,
    copy.leadNotification(brand, intro.ref_code, summary, place, neededBy, buyer),
    { name: svc.config.whatsapp.templates.leadNotification, params: [intro.ref_code, buyer ? `${buyer.name}: ${summary}` : summary] },
    { freeOnly: svc.config.leadNotices === "free_only" },
  );
  const runAt = new Date(svc.now().getTime() + svc.config.followUpDelayHours * 3600_000);
  await svc.jobs.enqueueOnce("follow_up", intro.id, { introductionId: intro.id }, runAt);
}

async function reshowResults(t: T, requestId: string): Promise<void> {
  const { svc, contact } = t;
  const request = await ownRequest(t, requestId);
  if (!request) return t.reply(copy.askWhatYouNeed(contact.profile_name));
  // Businesses they told us didn't reply or couldn't help aren't offered again for this request.
  const rows = await svc.db.query<Business & { rank: number }>(
    `SELECT b.*, rr.rank FROM request_results rr JOIN businesses b ON b.id = rr.business_id
      WHERE rr.request_id = $1 AND b.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = rr.request_id AND i.business_id = b.id
                          AND i.outcome IN ('no_reply', 'couldnt_help'))
      ORDER BY rr.rank`,
    [request.id],
  );
  const category = svc.taxonomy.get(request.category_slug);
  const place = request.area_id != null ? svc.gazetteer.get(request.area_id)?.name : undefined;
  const what: Need = { ...need(request.interpretation, category, request.understood_by), trade: !!request.buyer_business_id };
  if (!rows.length) return t.reply(copy.noOtherOptions(request.id));
  if (request.match === "related" && category) {
    return t.reply(copy.relatedResults(request.id, rows.map((b) => viewOf(t, b, request)), what, relatedLabel(t, category), place));
  }
  // What each business lists now: a price changed or a product sold out since the first list shows as it is.
  const retailInstead = request.match === "retail";
  const live = await safeProducts(t, {
    query: productQueryFor(t, request.interpretation, request.raw_text, request.query),
    businessIds: rows.map((b) => b.id),
    lat: request.lat ?? undefined,
    lng: request.lng ?? undefined,
    maxKm: 1e6,
    trade: request.buyer_business_id && !retailInstead ? "wholesale" : "retail",
  });
  const byBusiness = new Map(live.map((p) => [p.businessId, p.best]));
  const views = rows.map((b) => ({ ...viewOf(t, b, request), product: byBusiness.has(b.id) ? listed(t, byBusiness.get(b.id)!) : null }));
  if (views.some((v) => v.product)) {
    return t.reply(
      copy.productResults(request.id, views, what, place, { budget: request.interpretation?.budget_usd, sells: category?.goods ? category.phrase : undefined, retailInstead }),
    );
  }
  return t.reply(copy.results(request.id, views, what, place, { retailInstead }));
}

/**
 * "Not what I asked for" under the results: the request goes to the team's weekly check, and the
 * customer can say it again or talk to a person. If the engine still can't tell, a person takes over.
 */
async function notWhatTheyAsked(t: T, requestId: string): Promise<void> {
  const request = await ownRequest(t, requestId);
  if (!request) return t.reply(copy.askWhatYouNeed(t.contact.profile_name));
  await flagRequest(t.svc.db, request.id);
  resetSearch(t.state);
  t.state.unclear = true;
  t.svc.log.info({ contactId: t.contact.id, requestId: request.id }, "Customer said the results weren't what they asked for");
  return t.reply(copy.notWhatIAsked(request.id));
}

async function startHandoff(t: T, requestId: string | null, text: string | null, message?: OutboundMessage): Promise<void> {
  const { svc, state, contact } = t;
  state.stage = "handoff";
  const request = requestId ? await ownRequest(t, requestId) : undefined;
  if (request) {
    await setRequestStatus(svc.db, request.id, "handoff");
  } else if (text) {
    await createRequest(svc.db, {
      contactId: contact.id,
      rawText: text,
      interpretation: {
        intent: "human",
        category_slug: null,
        query: "",
        area: null,
        budget_usd: null,
        needed_by: null,
        clarifying_question: null,
        language: "en",
      },
      categorySlug: null,
      query: "",
      status: "handoff",
    });
  }
  svc.log.info({ contactId: contact.id, requestId }, "Handed over to a person");
  return t.reply(message ?? copy.handoff(whenTeamReplies(svc.now(), svc.config.teamHours)));
}

// ---------- Deleting their data ----------

async function eraseAnswer(t: T, yes: boolean): Promise<void> {
  if (!yes) return t.reply(copy.eraseCancelled());
  const { svc, contact } = t;
  await t.reply(copy.erased());
  // After the turn is saved, so the confirmation and this very message are deleted too.
  t.defer(async () => {
    const result = await eraseContact(svc.db, contact.id);
    // Their chats on the business side go too, unless they own a listing: the router sends an
    // owner's "delete my data" to the business side, which asks about their listings first.
    const asBusiness = await otherSide(svc.db, contact);
    if (asBusiness && !(await businessesOwnedBy(svc.db, asBusiness.id)).length) await eraseContact(svc.db, asBusiness.id);
    svc.log.info({ ...result }, "Customer deleted their data");
  });
}

// ---------- Recommendations ("know someone good?") ----------

async function continueRecommendation(t: T, text: string): Promise<void> {
  const { svc, state } = t;
  const rec = (state.rec ??= {});
  const noPhone = state.stage === "rec_phone" && isCommand(text, NO_PHONE);
  if (!noPhone && isCommand(text, ["cancel", "stop", "no"])) {
    state.stage = undefined;
    state.rec = undefined;
    return t.reply(copy.recCancelled());
  }
  switch (state.stage) {
    case "rec_name":
      if (text.length < 2) return t.reply(copy.recAskName());
      rec.name = text.slice(0, 80);
      state.stage = "rec_what";
      return t.reply(copy.recAskWhat(rec.name));
    case "rec_what":
      rec.what = text.slice(0, 300);
      state.stage = "rec_area";
      return t.reply(copy.recAskArea(rec.name ?? "them"));
    case "rec_area": {
      const area = svc.gazetteer.match(text, { fuzzy: true });
      return setRecommendationArea(t, area?.name ?? text.slice(0, 80), area?.id ?? null);
    }
    case "rec_phone": {
      if (noPhone) return saveRecommendation(t, null);
      const phone = normalizeZimPhone(text);
      if (!phone) return t.reply(copy.recBadPhone());
      return saveRecommendation(t, phone);
    }
    default:
      state.stage = undefined;
      return t.reply(copy.askWhatYouNeed(t.contact.profile_name));
  }
}

async function setRecommendationArea(t: T, areaText: string | null, areaId: number | null): Promise<void> {
  const rec = (t.state.rec ??= {});
  rec.areaText = areaText;
  rec.areaId = areaId;
  t.state.stage = "rec_phone";
  return t.reply(copy.recAskPhone(rec.name ?? "them"));
}

async function saveRecommendation(t: T, phone: string | null): Promise<void> {
  const { svc, state, contact } = t;
  const rec = state.rec;
  state.stage = undefined;
  state.rec = undefined;
  if (!rec?.name || !rec.what) return t.reply(copy.recCancelled());
  if (phone) {
    const listed = await one<{ name: string }>(svc.db, "SELECT name FROM businesses WHERE phone = $1 AND status = 'active' LIMIT 1", [phone]);
    if (listed) return t.reply(copy.recAlreadyListed(listed.name));
  }
  // Local only: a tip the engine can't place waits for the team to categorise.
  const classified = await svc.keywords.classifyBusiness(rec.what, { taxonomy: svc.taxonomy, lexicon: svc.lexicon });
  await createRecommendation(svc.db, {
    contactId: contact.id,
    name: rec.name,
    what: rec.what,
    categorySlug: classified.category_slugs[0] ?? null,
    areaText: rec.areaText ?? null,
    areaId: rec.areaId ?? null,
    phone,
  });
  svc.log.info({ contactId: contact.id }, "Customer recommended a business");
  return t.reply(copy.recThanks(rec.name));
}

// ---------- Follow-up answers ----------

/**
 * The follow-up's answers. "It didn't work out" asks what happened: no reply, or couldn't help
 * (didn't have it). Those count against the business's track record and ranking, and a
 * verified business that keeps letting customers down goes back to our field team.
 */
async function feedback(t: T, introId: string, outcome: string): Promise<void> {
  const { svc, contact } = t;
  const intro = await getIntroduction(svc.db, introId);
  if (!intro || intro.contact_id !== contact.id) return;
  const request = intro.request_id ? await getRequest(svc.db, intro.request_id) : undefined;
  const goods = svc.taxonomy.get(request?.category_slug)?.goods ?? false;
  switch (outcome) {
    case "failed":
      return t.reply(copy.whatHappened(intro.id, goods));
    case "other":
      // Something else went wrong: they tell us in their own words, as a report.
      return startReport(t, intro.business_id);
    case "sorted":
    case "not_yet":
    case "no_reply":
    case "couldnt_help":
      break;
    default:
      return;
  }
  // Tapping again changes nothing; changing their answer moves the score by the difference.
  const changed = await svc.db.query<{ id: string }>(
    "UPDATE introductions SET outcome = $2 WHERE id = $1 AND outcome IS NOT DISTINCT FROM $3 RETURNING id",
    [intro.id, outcome, intro.outcome],
  );
  const change = changed.length ? (OUTCOME_SCORE[outcome] ?? 0) - (OUTCOME_SCORE[intro.outcome ?? ""] ?? 0) : 0;
  if (change) await adjustResponseScore(svc.db, intro.business_id, change);
  if (outcome === "sorted") {
    const business = await getBusiness(svc.db, intro.business_id);
    return t.reply(copy.askRating(intro.id, business?.name ?? "them"));
  }
  if (outcome === "not_yet") return t.reply(copy.notYet(intro.request_id));
  return t.reply(copy.letDown(intro.request_id, intro.business_id, outcome, goods));
}

/** How each answer to the follow-up moves a business's response score. */
const OUTCOME_SCORE: Record<string, number> = { no_reply: -0.1, couldnt_help: -0.05, sorted: 0.05, not_yet: 0 };

/** Ask what went wrong with a business; their next message is the report. A few a day at most. */
async function startReport(t: T, businessId: string): Promise<void> {
  const { svc, contact, state } = t;
  const dayAgo = new Date(svc.now().getTime() - 24 * 3600_000);
  if ((await reportsSince(svc.db, contact.id, dayAgo)) >= svc.config.limits.reportsPerDay) return t.reply(copy.reportLimit());
  state.stage = "awaiting_report";
  state.reportBusinessId = businessId;
  return t.reply(copy.askReport());
}

async function rate(t: T, introId: string, stars: number): Promise<void> {
  const { svc, contact } = t;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return;
  const intro = await getIntroduction(svc.db, introId);
  if (!intro || intro.contact_id !== contact.id) return;
  const updated = await svc.db.query<{ business_id: string }>(
    "UPDATE introductions SET rating = $2 WHERE id = $1 AND rating IS NULL RETURNING business_id",
    [intro.id, stars],
  );
  if (updated[0]) await recordRating(svc.db, updated[0].business_id, stars);
  return t.reply(copy.ratingThanks());
}

// ---------- Products ----------

/**
 * What to look for in product names: the request's search words ("samsung 55 inch tv"), or its
 * wording without the place when there are none.
 */
function productQueryFor(t: T, interpretation: RequestInterpretation | null | undefined, raw: string, query?: string): ProductQuery {
  const text = wordsToMatch(raw, query || interpretation?.query, interpretation?.area, t.svc.gazetteer);
  return productQuery(text, t.svc.lexicon, interpretation?.budget_usd ?? null);
}

/** Product search never stops a reply: if it fails, the category search still answers. */
async function safeProducts(t: T, s: Parameters<typeof searchProducts>[1]): Promise<ProductHit[]> {
  try {
    return await searchProducts(t.svc.db, s);
  } catch (err) {
    t.svc.log.error({ err: String(err) }, "Product search failed; answering from categories");
    return [];
  }
}

/**
 * Businesses for a request: in its category, and those listing a matching product. Goods are
 * looked for in every business's listings (a hardware store may sell a fridge); a service only in
 * its own trade's listings ("fridge repair" never finds fridges for sale).
 */
async function findSuppliers(
  t: T,
  s: {
    lat?: number;
    lng?: number;
    limit: number;
    minVerified: number;
    trade: "retail" | "wholesale";
    excludeIds: string[];
    category: Category | undefined;
    text: string;
    products: ProductQuery;
  },
): Promise<{ suppliers: Supplier[]; productMatches: number }> {
  const { svc } = t;
  const service = s.category && !s.category.goods;
  const [byCategory, byProduct] = await Promise.all([
    searchBusinesses(svc.db, svc.taxonomy, {
      lat: s.lat,
      lng: s.lng,
      limit: s.limit,
      minVerified: s.minVerified,
      trade: s.trade,
      excludeIds: s.excludeIds,
      categorySlug: s.category?.slug ?? null,
      text: s.text,
    }),
    safeProducts(t, {
      query: s.products,
      lat: s.lat,
      lng: s.lng,
      maxKm: s.category?.needsLocation === false ? 1e6 : undefined,
      trade: s.trade,
      excludeIds: s.excludeIds,
      categorySlug: service ? s.category!.slug : undefined,
    }),
  ]);
  const suppliers = mergeSuppliers(byCategory, byProduct, {
    limit: s.limit,
    minVerified: s.minVerified,
    verifiedOnly: s.category?.risk === "high_scam",
    now: svc.now(),
  });
  return { suppliers, productMatches: byProduct.length };
}

/**
 * After the results list: WhatsApp's own product cards, with photos, for what the stores in it list
 * (up to three each). Only products already in our catalog; a problem here never costs the reply.
 */
async function sendProductCards(t: T, suppliers: Supplier[], what: Need, query: ProductQuery): Promise<void> {
  const { svc } = t;
  if (!svc.catalog || !svc.config.products.cards) return;
  try {
    const stores = suppliers.filter((s) => s.product).slice(0, 10);
    const found: { store: Supplier; matches: ProductMatch[] }[] = [];
    for (const store of stores) {
      const matches = (await productsOf(svc.db, store.id, query, 3)).filter((m) => m.photoId && m.price != null);
      if (matches.length) found.push({ store, matches });
    }
    const ids = found.flatMap((f) => f.matches.map((m) => m.id));
    if (!ids.length) return;
    // A card shows Meta's copy of the product: one changed a moment ago waits until the sync has sent it.
    const inCatalog = new Set(
      (
        await svc.db.query<{ retailer_id: string }>(
          `SELECT ci.retailer_id FROM catalog_items ci JOIN offerings o ON o.id = ci.offering_id
            WHERE ci.retailer_id = ANY($1::text[]) AND ci.error IS NULL AND NOT o.catalog_dirty`,
          [ids],
        )
      ).map((r) => r.retailer_id),
    );
    const sections = found
      .map((f) => ({
        title: f.store.name,
        products: f.matches
          .filter((m) => inCatalog.has(m.id))
          .map((m) => ({ id: m.id, name: m.name, price: priceOf(m), image: `${svc.config.publicBaseUrl}/media/products/${m.photoId}` })),
      }))
      .filter((s) => s.products.length);
    if (sections.length) await t.reply(copy.productCards(svc.catalog.catalogId, what, sections));
  } catch (err) {
    svc.log.error({ err: String(err) }, "Product cards failed; the results went out without them");
  }
}

/**
 * They asked about one product: from our product cards, a cart, or a product page's code. The
 * store's card, with its prices now, ready to connect. It keeps to the request that showed that
 * store when there is a recent one; otherwise the product becomes the request, so connecting and
 * follow-ups work as usual.
 */
async function askedAboutProduct(t: T, key: string, first?: OutboundMessage): Promise<void> {
  const { svc, contact, state } = t;
  const product = /^[0-9a-f]{8}$/.test(key) || /^[0-9a-f-]{36}$/i.test(key) ? await liveProduct(t, key, !!state.buying) : undefined;
  if (!product) return t.reply(copy.productGone());
  if (first) await t.reply(first);
  const shown = await one<{ id: string }>(
    svc.db,
    `SELECT r.id FROM requests r JOIN request_results rr ON rr.request_id = r.id
      WHERE r.contact_id = $1 AND rr.business_id = $2 AND rr.offering_id = $4 AND r.created_at > $3
      ORDER BY r.created_at DESC LIMIT 1`,
    [contact.id, product.business_id, new Date(svc.now().getTime() - 7 * 24 * 3600_000), product.id],
  );
  let requestId = shown?.id;
  if (!requestId) {
    const request = await createRequest(svc.db, {
      contactId: contact.id,
      rawText: `Asked about ${product.name}`.slice(0, 500),
      interpretation: {
        intent: "search",
        category_slug: null,
        query: product.name.slice(0, 80),
        area: null,
        budget_usd: null,
        needed_by: null,
        clarifying_question: null,
        language: "en",
      },
      categorySlug: null,
      query: product.name.slice(0, 80),
      understoodBy: "customer",
    });
    await saveResults(svc.db, request.id, [{ businessId: product.business_id, offeringId: product.id }]);
    await setRequestStatus(svc.db, request.id, "answered", 1, "exact", 1);
    requestId = request.id;
  }
  state.lastRequestId = requestId;
  return showBusiness(t, requestId, product.business_id);
}

/**
 * A product customers can still buy, by its ID or the first 8 characters of it. A store that
 * sells only to businesses is for businesses looking for supplies.
 */
async function liveProduct(t: T, key: string, forBusiness: boolean): Promise<{ id: string; business_id: string; name: string } | undefined> {
  const exact = key.length === 36;
  return one<{ id: string; business_id: string; name: string }>(
    t.svc.db,
    `SELECT o.id, o.business_id, o.name FROM offerings o JOIN businesses b ON b.id = o.business_id
      WHERE ${exact ? "o.id::text = $1" : "o.id::text LIKE $1 || '%'"}
        AND o.archived_at IS NULL AND o.in_stock AND b.status = 'active'
        AND ($2::boolean OR b.trade <> 'wholesale')
      ORDER BY o.updated_at DESC LIMIT 1`,
    [key.toLowerCase(), forBusiness],
  );
}

function listed(t: T, m: ProductMatch): ListedProduct {
  return { name: m.name, price: priceOf(m), amount: m.price, unit: m.unit, updated: copy.updatedPhrase(m.priceUpdatedAt, t.svc.now()) };
}

function supplierView(t: T, s: Supplier | BusinessHit): BusinessView {
  const product = "product" in s && s.product ? listed(t, s.product) : null;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    verification: s.verification,
    areaName: s.areaName,
    distanceKm: s.distanceKm,
    ratingAvg: s.ratingAvg,
    ratingCount: s.ratingCount,
    product,
  };
}

/** Results as a list: with products and prices when stores list what was asked, otherwise by category. */
function resultsMessage(
  t: T,
  requestId: string,
  suppliers: Supplier[],
  what: Need,
  place: string | undefined,
  category: Category | undefined,
  opts: { budget?: number | null; retailInstead?: boolean },
): OutboundMessage {
  const views = suppliers.map((s) => supplierView(t, s));
  if (views.some((v) => v.product)) {
    return copy.productResults(requestId, views, what, place, { budget: opts.budget, sells: category?.goods ? category.phrase : undefined, retailInstead: opts.retailInstead });
  }
  return copy.results(requestId, views, what, place, { retailInstead: opts.retailInstead });
}

// ---------- Helpers ----------

async function ownRequest(t: T, requestId: string): Promise<RequestRow | undefined> {
  if (!requestId) return undefined;
  const request = await getRequest(t.svc.db, requestId);
  return request && request.contact_id === t.contact.id ? request : undefined;
}

function viewOf(t: T, b: Business, request?: RequestRow): BusinessView {
  const area = t.svc.gazetteer.get(b.area_id);
  const distanceKm =
    request?.lat != null && request.lng != null && b.lat != null && b.lng != null
      ? haversineKm(request.lat, request.lng, b.lat, b.lng)
      : null;
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    verification: b.verification,
    areaName: area?.name ?? null,
    distanceKm,
    ratingAvg: b.rating_count > 0 ? b.rating_sum / b.rating_count : null,
    ratingCount: b.rating_count,
    address: b.address,
    hours: b.hours,
  };
}

/** "electronics and appliances businesses" when the related categories are one kind of business. */
function relatedLabel(t: T, category: Category): string {
  const groups = new Set(category.related.map((slug) => t.svc.taxonomy.get(slug)?.group).filter(Boolean));
  const [group] = [...groups];
  return groups.size === 1 && group ? `${group.toLowerCase()} businesses` : "businesses that sell or do similar things";
}

/** Words that name a kind of shop or supplier rather than an item: "a phone shop" has phones. */
const SHOP_WORDS = new Set(
  (
    "shop shops store stores supermarket supermarkets dealer dealers supplier suppliers seller sellers vendor vendors " +
    "outlet outlets boutique boutiques wholesaler wholesalers retailer retailers butcher butchers butchery baker bakers " +
    "bakery pharmacy pharmacies chemist chemists company companies business businesses place places " +
    // and kinds of supplier, for businesses buying stock: "cement wholesale" has cement
    "wholesale wholesaler wholesalers bulk supplier suppliers distributor distributors stockist stockists"
  ).split(" "),
);

/**
 * What they asked for, as replies name it. Replies are always in English.
 * - A service is named by what its businesses offer ("plumbing services"): "businesses that
 *   offer plumbing services", never "businesses for plumber".
 * - Goods are the item in the customer's words when they wrote in English (Claude's query is
 *   English): "they have *samsung tv*". Words that only name a kind of shop ("butcher", "phone
 *   shop") or a request in Shona or Ndebele use what the category's stores have ("meat").
 */
function need(i: RequestInterpretation | undefined, category: Category | undefined, by: string | null | undefined): Need {
  const english = i?.language === "en" || by === "claude";
  const words = english && i?.query ? normalizeText(i.query).split(" ").filter((w) => w && !SHOP_WORDS.has(w)) : [];
  if (!category) return { kind: "other", text: words.length ? i!.query : "what you asked for" };
  if (!category.goods) return { kind: "service", text: category.phrase };
  return { kind: "goods", text: words.length ? words.join(" ") : category.phrase };
}

function resetSearch(state: CustomerState): void {
  state.stage = undefined;
  state.pending = undefined;
  state.choice = undefined;
  state.pendingText = undefined;
  state.reportBusinessId = undefined;
  state.rec = undefined;
  state.unclear = undefined;
}

function isCommand(text: string, words: string[]): boolean {
  return words.includes(normalizeText(text));
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
