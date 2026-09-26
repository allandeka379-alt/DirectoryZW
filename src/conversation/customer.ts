import { remember } from "../ai/phrasebook.js";
import type { RequestInterpretation } from "../ai/types.js";
import type { ReaderContext, ReadingSummary, Understanding, UnderstoodBy } from "../ai/understanding.js";
import { one } from "../db/client.js";
import { adjustResponseScore, getBusiness, recordRating, type Business } from "../directory/businesses.js";
import { haversineKm } from "../directory/gazetteer.js";
import { createIntroduction, getIntroduction, waMeLink } from "../directory/introductions.js";
import { matchingOfferings, priceLabel } from "../directory/offerings.js";
import { createRecommendation } from "../directory/recommendations.js";
import { fileReport, reportsSince } from "../directory/reports.js";
import { searchBusinesses, searchRelated } from "../directory/search.js";
import { trackRecord } from "../directory/trust.js";
import type { Category } from "../directory/taxonomy.js";
import { eraseContact } from "../privacy.js";
import { containsPhrase, normalizeText, normalizeZimPhone } from "../text.js";
import { whenTeamReplies } from "../time.js";
import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import type { BusinessView, Need, PriceView } from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import {
  createRequest,
  flagRequest,
  getRequest,
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
  location?: { lat: number; lng: number; areaId: number | null; label: string };
  reportBusinessId?: string;
  /** A recommendation being written. */
  rec?: { name?: string; what?: string; areaText?: string | null; areaId?: number | null };
  /** We already asked them to say it differently; next time a person takes over. */
  unclear?: boolean;
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
  const { contact, inbound, state } = t;
  if (contact.is_blocked) return;

  // Deleting their data works at any point, even before consent or while a person is handling the chat.
  const c0 = inbound.content;
  if (c0.type === "text" && isCommand(c0.text, ERASE_WORDS)) return t.reply(copy.eraseConfirm());
  if ((c0.type === "button_reply" || c0.type === "list_reply") && (c0.id === Ids.eraseYes || c0.id === Ids.eraseNo)) {
    return eraseAnswer(t, c0.id === Ids.eraseYes);
  }

  // A person from the team is handling this chat; only "menu" brings the assistant back.
  if (state.stage === "handoff") {
    if (inbound.content.type === "text" && isCommand(inbound.content.text, ["menu", "bot", "assistant"])) {
      state.stage = undefined;
      await t.reply(copy.welcomeBack());
    }
    return;
  }

  if (!contact.consent_at) return consentGate(t);

  const c = inbound.content;
  switch (c.type) {
    case "text":
      return onText(t, c.text);
    case "button_reply":
    case "list_reply":
      return onAction(t, c.id);
    case "location":
      return onLocation(t, c.lat, c.lng);
    // Typed messages only, for now: voice notes and photos aren't read.
    case "image":
    case "audio":
      return t.reply(copy.typeInstead());
    default:
      return t.reply(copy.help(t.svc.config.brandName));
  }
}

async function consentGate(t: T): Promise<void> {
  const { contact, inbound, state, svc } = t;
  const c = inbound.content;
  if (c.type === "button_reply" && c.id === Ids.consent) {
    await setConsent(svc.db, contact.id);
    contact.consent_at = svc.now();
    const { pendingText } = state;
    state.stage = undefined;
    state.pendingText = undefined;
    if (pendingText) return onText(t, pendingText);
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
    return t.reply(copy.stopped());
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
    const area = svc.gazetteer.match(raw, { fuzzy: true });
    const pending = state.pending;
    state.stage = undefined;
    state.pending = undefined;
    if (area) {
      const place = { areaId: area.id, lat: area.lat, lng: area.lng, label: area.name };
      state.location = place;
      return runSearch(t, pending.raw, pending.interpretation, pending.by, place, pending.reading);
    }
    // Not a place we know: treat it as a new request.
  }

  if (state.stage === "awaiting_choice" && state.choice) {
    const choice = state.choice;
    state.stage = undefined;
    state.choice = undefined;
    // They may answer in words ("hire", "yes"). If that settles it, it's their pick; otherwise it's a new request.
    const picked = pickInWords(t, raw, choice);
    if (picked !== undefined) return answerChoice(t, choice, picked);
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
  const place: Place | undefined = area ? { areaId: area.id, lat: area.lat, lng: area.lng, label: area.name } : state.location;
  if (!place && category?.needsLocation !== false) {
    state.stage = "awaiting_area";
    state.pending = { raw, interpretation, by, reading };
    return t.reply(copy.askLocation(need(interpretation, category, by)));
  }
  if (area) state.location = place;
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
  state.location = place;
  if (state.stage === "awaiting_area" && state.pending) {
    const pending = state.pending;
    state.stage = undefined;
    state.pending = undefined;
    return runSearch(t, pending.raw, pending.interpretation, pending.by, place, pending.reading);
  }
  return t.reply(copy.locationSaved(place.label));
}

/**
 * Suppliers for a request: those in its own category first. If none are nearby, suppliers in
 * related categories (a gadget nobody lists goes to our electronics shops). If there are none of
 * those either, a person from the team takes over straight away. Related-only and handed-over
 * requests are supply gaps for the field team.
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
  });
  state.lastRequestId = request.id;
  state.lastQuery = raw;
  const what = need(interpretation, category, by);
  const search = {
    lat: place?.lat,
    lng: place?.lng,
    limit: svc.config.maxResults,
    minVerified: svc.config.minVerifiedResults,
  };

  const hits = await searchBusinesses(svc.db, svc.taxonomy, {
    ...search,
    categorySlug: category?.slug ?? null,
    text: interpretation.query || raw,
  });
  if (hits.length) {
    await saveResults(svc.db, request.id, hits.map((h) => h.id));
    await setRequestStatus(svc.db, request.id, "answered", hits.length, "exact");
    return t.reply(copy.results(request.id, hits, what, place?.label));
  }

  const related = category ? await searchRelated(svc.db, svc.taxonomy, { ...search, categorySlug: category.slug }) : [];
  if (category && related.length) {
    await saveResults(svc.db, request.id, related.map((h) => h.id));
    await setRequestStatus(svc.db, request.id, "answered", related.length, "related");
    return t.reply(copy.relatedResults(request.id, related, what, relatedLabel(t, category), place?.label));
  }

  await setRequestStatus(svc.db, request.id, "handoff", 0, "none");
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

/** Price-list items matching what the customer asked for. */
async function pricesFor(t: T, businessId: string, request: RequestRow): Promise<PriceView | undefined> {
  const text = [request.query, request.raw_text].filter(Boolean).join(" ");
  const matches = await matchingOfferings(t.svc.db, businessId, text, 3);
  if (!matches.length) return undefined;
  return {
    items: matches.map((o) => ({ name: o.name, price: priceLabel(o) })),
    updatedAt: new Date(Math.max(...matches.map((o) => new Date(o.created_at).getTime()))),
  };
}

async function connect(t: T, requestId: string, businessId: string): Promise<void> {
  const { svc, contact } = t;
  const business = await getBusiness(svc.db, businessId);
  if (!business || business.status !== "active") return t.reply(copy.noLongerAvailable());
  const request = await ownRequest(t, requestId);
  const intro = await createIntroduction(svc.db, { requestId: request?.id ?? null, contactId: contact.id, businessId });
  if (request) await setRequestStatus(svc.db, request.id, "connected");

  const summary = truncate(request?.raw_text ?? "your products or services", 160);
  const brand = svc.config.brandName;
  const view = viewOf(t, business, request);
  const link = waMeLink(business.phone, copy.prefilledMessage(brand, business.name, intro.ref_code, summary));
  await t.reply(copy.connectLink(view, link, intro.ref_code));

  const place = request?.area_id != null ? svc.gazetteer.get(request.area_id)?.name : null;
  const neededBy = request?.interpretation?.needed_by ?? null;
  await svc.messenger.notify("business", business.phone, copy.leadNotification(brand, intro.ref_code, summary, place, neededBy), {
    name: svc.config.whatsapp.templates.leadNotification,
    params: [intro.ref_code, summary],
  });
  const runAt = new Date(svc.now().getTime() + svc.config.followUpDelayHours * 3600_000);
  await svc.jobs.enqueue("follow_up", { introductionId: intro.id }, runAt);
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
  const what = need(request.interpretation, category, request.understood_by);
  if (!rows.length) return t.reply(copy.noOtherOptions(request.id));
  const views = rows.map((b) => viewOf(t, b, request));
  if (request.match === "related" && category) return t.reply(copy.relatedResults(request.id, views, what, relatedLabel(t, category), place));
  return t.reply(copy.results(request.id, views, what, place));
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
    svc.log.info({ ...result }, "Customer deleted their data");
  });
}

// ---------- Recommendations ("know someone good?") ----------

async function continueRecommendation(t: T, text: string): Promise<void> {
  const { svc, state } = t;
  const rec = (state.rec ??= {});
  if (isCommand(text, ["cancel", "stop", "no"])) {
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
      if (isCommand(text, ["skip", "dont know", "i dont know", "no idea"])) return saveRecommendation(t, null);
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
  await svc.db.query("UPDATE introductions SET outcome = $2 WHERE id = $1", [intro.id, outcome]);
  const change = outcome === "no_reply" ? -0.1 : outcome === "couldnt_help" ? -0.05 : outcome === "sorted" ? 0.05 : 0;
  if (change) await adjustResponseScore(svc.db, intro.business_id, change);
  if (outcome === "sorted") {
    const business = await getBusiness(svc.db, intro.business_id);
    return t.reply(copy.askRating(intro.id, business?.name ?? "them"));
  }
  if (outcome === "not_yet") return t.reply(copy.notYet(intro.request_id));
  return t.reply(copy.letDown(intro.request_id, intro.business_id, outcome, goods));
}

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
  };
}

/** "electronics and appliances businesses" when the related categories are one kind of business. */
function relatedLabel(t: T, category: Category): string {
  const groups = new Set(category.related.map((slug) => t.svc.taxonomy.get(slug)?.group).filter(Boolean));
  const [group] = [...groups];
  return groups.size === 1 && group ? `${group.toLowerCase()} businesses` : "businesses that sell or do similar things";
}

/** Words that name a kind of shop rather than an item: "a phone shop" has phones. */
const SHOP_WORDS = new Set(
  (
    "shop shops store stores supermarket supermarkets dealer dealers supplier suppliers seller sellers vendor vendors " +
    "outlet outlets boutique boutiques wholesaler wholesalers retailer retailers butcher butchers butchery baker bakers " +
    "bakery pharmacy pharmacies chemist chemists company companies business businesses place places"
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
