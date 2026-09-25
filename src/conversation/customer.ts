import type { RequestInterpretation } from "../ai/types.js";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { adjustResponseScore, getBusiness, recordRating, type Business } from "../directory/businesses.js";
import { haversineKm } from "../directory/gazetteer.js";
import { createIntroduction, getIntroduction, waMeLink } from "../directory/introductions.js";
import { matchingOfferings, priceLabel } from "../directory/offerings.js";
import {
  cachedLeads,
  getLead,
  leadsForRequest,
  linkLeadsToRequest,
  markLeadConnected,
  onlineSearchesSince,
  saveLeads,
  type OnlineLead,
} from "../directory/online-leads.js";
import { createRecommendation } from "../directory/recommendations.js";
import { searchBusinesses } from "../directory/search.js";
import type { Category } from "../directory/taxonomy.js";
import { hostOf } from "../ai/online-finder.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import type { BusinessView, LeadView, PriceView } from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import { fetchMedia, hearVoiceNote } from "./media.js";
import {
  annotateInbound,
  createReport,
  createRequest,
  getRequest,
  saveResults,
  setConsent,
  setRequestStatus,
  type RequestRow,
} from "./store.js";

export interface CustomerState {
  stage?: "awaiting_consent" | "awaiting_area" | "awaiting_report" | "handoff" | "rec_name" | "rec_what" | "rec_area" | "rec_phone";
  /** First message, kept while we ask for consent. */
  pendingText?: string;
  /** A photo or voice note sent before consent; handled once they agree. */
  pendingMedia?: { type: "image" | "audio"; mediaId: string; caption?: string; waMessageId: string };
  /** A request waiting for the customer's location. */
  pending?: { raw: string; interpretation: RequestInterpretation };
  lastRequestId?: string;
  lastQuery?: string;
  location?: { lat: number; lng: number; areaId: number | null; label: string };
  reportBusinessId?: string;
  /** A recommendation being written. */
  rec?: { name?: string; what?: string; areaText?: string | null; areaId?: number | null };
}

type T = Turn<CustomerState>;

interface Place {
  areaId: number | null;
  lat: number;
  lng: number;
  label: string;
}

/** Requests that came from a photo start with this, so the business can be asked to look at it. */
const PHOTO_MARK = "📷 ";
const RECOMMEND_WORDS = ["recommend", "recommend a business", "suggest a business", "recommendation"];

export async function handleCustomerTurn(t: T): Promise<void> {
  const { contact, inbound, state } = t;
  if (contact.is_blocked) return;

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
    case "image":
      return onPhoto(t, c.mediaId, c.caption);
    case "audio":
      return onVoice(t, c.mediaId);
    default:
      return t.reply(copy.help(t.svc.config.brandName, features(t)));
  }
}

async function consentGate(t: T): Promise<void> {
  const { contact, inbound, state, svc } = t;
  const c = inbound.content;
  if (c.type === "button_reply" && c.id === Ids.consent) {
    await setConsent(svc.db, contact.id);
    contact.consent_at = svc.now();
    const { pendingText, pendingMedia } = state;
    state.stage = undefined;
    state.pendingText = undefined;
    state.pendingMedia = undefined;
    // Photos and voice notes are only processed once the customer has agreed.
    if (pendingMedia?.type === "image") return onPhoto(t, pendingMedia.mediaId, pendingMedia.caption);
    if (pendingMedia?.type === "audio") return onVoice(t, pendingMedia.mediaId, pendingMedia.waMessageId);
    if (pendingText) return onText(t, pendingText);
    return t.reply(copy.askWhatYouNeed(contact.profile_name));
  }
  if (!state.pendingText && !state.pendingMedia) {
    if (c.type === "text") state.pendingText = c.text.slice(0, 500);
    if (c.type === "image") state.pendingMedia = { type: "image", mediaId: c.mediaId, caption: c.caption, waMessageId: inbound.waMessageId };
    if (c.type === "audio") state.pendingMedia = { type: "audio", mediaId: c.mediaId, waMessageId: inbound.waMessageId };
  }
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
  if (isCommand(raw, ["help"])) return t.reply(copy.help(svc.config.brandName, features(t)));
  if (isCommand(raw, RECOMMEND_WORDS)) {
    resetSearch(state);
    state.stage = "rec_name";
    state.rec = {};
    return t.reply(copy.recAskName());
  }

  if (state.stage === "awaiting_report" && state.reportBusinessId) {
    await createReport(svc.db, contact.id, state.reportBusinessId, raw);
    state.stage = undefined;
    state.reportBusinessId = undefined;
    return t.reply(copy.reportThanks());
  }

  if (state.stage?.startsWith("rec_")) return continueRecommendation(t, raw);

  if (state.stage === "awaiting_area" && state.pending) {
    const area = svc.gazetteer.match(raw);
    const pending = state.pending;
    state.stage = undefined;
    state.pending = undefined;
    if (area) {
      const place = { areaId: area.id, lat: area.lat, lng: area.lng, label: area.name };
      state.location = place;
      return runSearch(t, pending.raw, pending.interpretation, place);
    }
    // Not a place we know: treat it as a new request.
  }

  const interpretation = await svc.interpreter.interpretRequest(raw, {
    taxonomy: svc.taxonomy,
    gazetteer: svc.gazetteer,
    previousRequest: state.lastQuery,
  });
  return handleInterpretation(t, raw, interpretation);
}

/** What to do with a request once we know what it means, whether it came as text, a voice note or a photo. */
async function handleInterpretation(t: T, raw: string, interpretation: RequestInterpretation): Promise<void> {
  const { svc, state, contact } = t;
  switch (interpretation.intent) {
    case "greeting":
      return t.reply(copy.askWhatYouNeed(contact.profile_name));
    case "help":
      return t.reply(copy.help(svc.config.brandName, features(t)));
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
      });
      return t.reply(copy.blocked());
    case "out_of_scope":
      return t.reply(copy.outOfScope());
    case "unclear":
      return t.reply(copy.clarify(interpretation.clarifying_question));
    case "search":
      break;
  }

  const category = svc.taxonomy.get(interpretation.category_slug);
  if (category?.risk === "blocked") return t.reply(copy.blocked());
  if (category?.risk === "restricted") return t.reply(copy.restricted(category.name));
  if (!category && (!interpretation.query || interpretation.clarifying_question)) {
    return t.reply(copy.clarify(interpretation.clarifying_question));
  }

  const area = (interpretation.area && svc.gazetteer.match(interpretation.area)) || svc.gazetteer.match(raw);
  const place: Place | undefined = area ? { areaId: area.id, lat: area.lat, lng: area.lng, label: area.name } : state.location;
  if (!place && category?.needsLocation !== false) {
    state.stage = "awaiting_area";
    state.pending = { raw, interpretation };
    return t.reply(copy.askLocation(need(interpretation, category)));
  }
  if (area) state.location = place;
  return runSearch(t, raw, interpretation, category?.needsLocation === false && !area ? undefined : place);
}

async function onPhoto(t: T, mediaId: string, caption?: string): Promise<void> {
  const { svc, state } = t;
  if (!svc.vision) return t.reply(copy.photosNotYet());
  const image = await fetchMedia(t, mediaId);
  if (!image) return;
  const interpretation = await svc.vision.interpretPhoto(image, caption, {
    taxonomy: svc.taxonomy,
    gazetteer: svc.gazetteer,
    previousRequest: state.lastQuery,
  });
  if (!interpretation) return t.reply(copy.photoUnreadable());
  await annotateInbound(svc.db, t.inbound.waMessageId, { seen: interpretation.query });
  resetSearch(state);
  const raw = `${PHOTO_MARK}${caption?.trim() ? `${caption.trim()} (${interpretation.query})` : interpretation.query}`;
  return handleInterpretation(t, raw, interpretation);
}

async function onVoice(t: T, mediaId: string, waMessageId?: string): Promise<void> {
  const text = await hearVoiceNote(t, mediaId, waMessageId);
  if (text) return onText(t, text);
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
    return runSearch(t, pending.raw, pending.interpretation, place);
  }
  return t.reply(copy.locationSaved(place.label));
}

async function runSearch(t: T, raw: string, interpretation: RequestInterpretation, place?: Place): Promise<void> {
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
  });
  const hits = await searchBusinesses(svc.db, svc.taxonomy, {
    categorySlug: category?.slug ?? null,
    text: interpretation.query || raw,
    lat: place?.lat,
    lng: place?.lng,
    limit: svc.config.maxResults,
    minVerified: svc.config.minVerifiedResults,
  });
  await saveResults(svc.db, request.id, hits.map((h) => h.id));
  await setRequestStatus(svc.db, request.id, hits.length ? "answered" : "no_results", hits.length);
  state.lastRequestId = request.id;
  state.lastQuery = raw;
  const what = need(interpretation, category);
  if (hits.length) return t.reply(copy.results(request.id, hits, what, place?.label));

  // Nothing listed: look online, labelled as unchecked. The request stays a supply gap for the field team.
  const leads = await findOnline(t, request, interpretation, category, place);
  if (leads.length) return t.reply(copy.onlineResults(request.id, leads.map((l) => leadView(l, request)), what, place?.label));
  return t.reply(copy.noResults(request.id, what, place?.label));
}

/**
 * Businesses found on the web for a request with no listed results. Reuses recent finds for the
 * same category nearby before searching again, never runs for high-scam categories, and caps how
 * many web searches one customer can trigger per day.
 */
async function findOnline(
  t: T,
  request: RequestRow,
  interpretation: RequestInterpretation,
  category: Category | undefined,
  place?: Place,
): Promise<OnlineLead[]> {
  const { svc, contact } = t;
  if (!svc.finder || category?.risk === "high_scam" || category?.risk === "blocked" || category?.risk === "restricted") return [];
  const query = interpretation.query || category?.name.toLowerCase() || "";
  if (!query) return [];
  let leads = await cachedLeads(svc.db, {
    categorySlug: category?.slug ?? null,
    query,
    lat: place?.lat,
    lng: place?.lng,
    maxKm: 40,
    limit: 5,
    now: svc.now(),
  });
  if (!leads.length) {
    const dayAgo = new Date(svc.now().getTime() - 24 * 3600_000);
    if ((await onlineSearchesSince(svc.db, contact.id, dayAgo)) >= svc.config.onlineSearch.perCustomerPerDay) return [];
    await t.reply(copy.searchingOnline(need(interpretation, category), place?.label));
    const area = place?.areaId != null ? svc.gazetteer.get(place.areaId) : undefined;
    const found = await svc.finder.find({
      query,
      categoryName: category?.name ?? null,
      place: area ? (area.name === area.city ? area.name : `${area.name}, ${area.city}`) : null,
      city: area?.city ?? null,
    });
    leads = await saveLeads(svc.db, svc.gazetteer, found, {
      categorySlug: category?.slug ?? null,
      query,
      place,
      expiresAt: new Date(svc.now().getTime() + svc.config.onlineSearch.leadDays * 24 * 3600_000),
    });
    await svc.db.query("UPDATE requests SET online_searched_at = $2 WHERE id = $1", [request.id, svc.now()]);
  }
  await linkLeadsToRequest(svc.db, request.id, leads.map((l) => l.id));
  await svc.db.query("UPDATE requests SET online_results = $2 WHERE id = $1", [request.id, leads.length]);
  return leads;
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
    case "obiz":
      return showLead(t, args[0] ?? "", args[1] ?? "");
    case "ocon":
      return connectLead(t, args[0] ?? "", args[1] ?? "");
    case "list":
      return reshowResults(t, args[0] ?? "");
    case "ask":
      return askAround(t, args[0] ?? "");
    case "human":
      return startHandoff(t, args[0] || null, null);
    case "new":
      resetSearch(state);
      return t.reply(copy.askWhatYouNeed(contact.profile_name));
    case "rep":
      state.stage = "awaiting_report";
      state.reportBusinessId = args[0];
      return t.reply(copy.askReport());
    case "fb":
      return feedback(t, args[0] ?? "", args[1] ?? "");
    case "rate":
      return rate(t, args[0] ?? "", Number(args[1]));
    default:
      return t.reply(copy.help(svc.config.brandName, features(t)));
  }
}

async function showBusiness(t: T, requestId: string, businessId: string): Promise<void> {
  const { svc } = t;
  const business = await getBusiness(svc.db, businessId);
  if (!business || business.status !== "active") return t.reply(copy.noLongerAvailable());
  const request = await ownRequest(t, requestId);
  const prices = request ? await pricesFor(t, business.id, request) : undefined;
  return t.reply(copy.businessCard(request?.id ?? "", viewOf(t, business, request), prices));
}

/** Price-list items matching what the customer asked for. */
async function pricesFor(t: T, businessId: string, request: RequestRow): Promise<PriceView | undefined> {
  const text = [request.query, request.raw_text.replace(PHOTO_MARK, "")].filter(Boolean).join(" ");
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
  await t.reply(copy.connectLink(view, link, intro.ref_code, fromPhoto(request)));

  const place = request?.area_id != null ? svc.gazetteer.get(request.area_id)?.name : null;
  const neededBy = request?.interpretation?.needed_by ?? null;
  await svc.messenger.notify("business", business.phone, copy.leadNotification(brand, intro.ref_code, summary, place, neededBy), {
    name: svc.config.whatsapp.templates.leadNotification,
    params: [intro.ref_code, summary],
  });
  const runAt = new Date(svc.now().getTime() + svc.config.followUpDelayHours * 3600_000);
  await svc.jobs.enqueue("follow_up", { introductionId: intro.id }, runAt);
}

async function showLead(t: T, requestId: string, leadId: string): Promise<void> {
  const lead = await getLead(t.svc.db, leadId);
  const request = await ownRequest(t, requestId);
  if (!lead || !request) return t.reply(copy.noLongerAvailable());
  return t.reply(copy.onlineCard(request.id, leadView(lead, request)));
}

/**
 * Open a chat with a business found online. They never signed up, so we don't message them
 * and don't follow up; the customer gets a link with their request typed in.
 */
async function connectLead(t: T, requestId: string, leadId: string): Promise<void> {
  const { svc } = t;
  const lead = await getLead(svc.db, leadId);
  const request = await ownRequest(t, requestId);
  if (!lead || !request) return t.reply(copy.noLongerAvailable());
  await markLeadConnected(svc.db, lead.id);
  const summary = truncate(request.raw_text, 160);
  const link = waMeLink(lead.phone, copy.onlinePrefilledMessage(svc.config.brandName, lead.name, summary));
  return t.reply(copy.onlineConnectLink(leadView(lead, request), link, fromPhoto(request)));
}

async function reshowResults(t: T, requestId: string): Promise<void> {
  const { svc, contact } = t;
  const request = await ownRequest(t, requestId);
  if (!request) return t.reply(copy.askWhatYouNeed(contact.profile_name));
  const rows = await svc.db.query<Business & { rank: number }>(
    `SELECT b.*, rr.rank FROM request_results rr JOIN businesses b ON b.id = rr.business_id
      WHERE rr.request_id = $1 AND b.status = 'active' ORDER BY rr.rank`,
    [request.id],
  );
  const category = svc.taxonomy.get(request.category_slug);
  const place = request.area_id != null ? svc.gazetteer.get(request.area_id)?.name : undefined;
  const what = need(request.interpretation, category);
  if (rows.length) return t.reply(copy.results(request.id, rows.map((b) => viewOf(t, b, request)), what, place));
  const leads = await leadsForRequest(svc.db, request.id);
  if (leads.length) return t.reply(copy.onlineResults(request.id, leads.map((l) => leadView(l, request)), what, place));
  return t.reply(copy.noResults(request.id, what, place));
}

/** Send the request to businesses that might help and aren't in the results yet. */
async function askAround(t: T, requestId: string): Promise<void> {
  const { svc } = t;
  const request = await ownRequest(t, requestId);
  if (!request) return t.reply(copy.askWhatYouNeed(t.contact.profile_name));
  const category = svc.taxonomy.get(request.category_slug);
  const targets = category ? await askAroundTargets(svc.db, request, category) : [];
  if (!targets.length) return startHandoff(t, request.id, null);

  const place = request.area_id != null ? svc.gazetteer.get(request.area_id)?.name : null;
  const what = truncate(request.raw_text, 160);
  let sent = 0;
  for (const b of targets) {
    const ask = await one<{ id: string }>(
      svc.db,
      "INSERT INTO ask_around (request_id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
      [request.id, b.id],
    );
    if (!ask) continue;
    await svc.messenger.notify("business", b.phone, copy.askAroundToBusiness(ask.id, what, place, request.interpretation?.needed_by), {
      name: svc.config.whatsapp.templates.askAround,
      params: [what, place ?? "Zimbabwe"],
      quickReplies: [
        { id: Ids.askAroundYes(ask.id), title: "Yes, I can help" },
        { id: Ids.askAroundNo(ask.id), title: "No" },
      ],
    });
    sent++;
  }
  if (!sent) return startHandoff(t, request.id, null);
  await setRequestStatus(svc.db, request.id, "asked_around");
  return t.reply(copy.askAroundStarted(sent));
}

async function askAroundTargets(
  db: Db,
  request: RequestRow,
  category: Category,
): Promise<{ id: string; phone: string; lat: number | null; lng: number | null }[]> {
  const shown = (
    await db.query<{ business_id: string }>("SELECT business_id FROM request_results WHERE request_id = $1", [request.id])
  ).map((r) => r.business_id);
  const run = async (condition: string, value: string) => {
    const rows = await db.query<{ id: string; phone: string; lat: number | null; lng: number | null; verification: string }>(
      `SELECT b.id, b.phone, b.lat, b.lng, b.verification FROM businesses b
        WHERE b.status = 'active' AND b.opted_in_at IS NOT NULL AND NOT (b.id::text = ANY($2::text[]))
          AND EXISTS (SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
                       WHERE bc.business_id = b.id AND ${condition} AND c.risk IN ('normal', 'high_scam'))
        ORDER BY (b.verification = 'verified') DESC, b.response_score DESC
        LIMIT 100`,
      [value, shown],
    );
    return rows.filter((b) => {
      if (category.risk === "high_scam" && b.verification !== "verified") return false;
      if (request.lat == null || request.lng == null || b.lat == null || b.lng == null) return true;
      return haversineKm(request.lat, request.lng, b.lat, b.lng) <= 60;
    });
  };
  const sameCategory = await run("bc.category_slug = $1", category.slug);
  const targets = sameCategory.length ? sameCategory : await run("c.group_name = $1", category.group);
  return targets.slice(0, 8);
}

async function startHandoff(t: T, requestId: string | null, text: string | null): Promise<void> {
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
  return t.reply(copy.handoff());
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
      const area = svc.gazetteer.match(text);
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
  const classified = await svc.interpreter.classifyBusiness(rec.what, { taxonomy: svc.taxonomy });
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

async function feedback(t: T, introId: string, outcome: string): Promise<void> {
  const { svc, contact } = t;
  const intro = await getIntroduction(svc.db, introId);
  if (!intro || intro.contact_id !== contact.id) return;
  if (outcome !== "sorted" && outcome !== "not_yet" && outcome !== "no_reply") return;
  await svc.db.query("UPDATE introductions SET outcome = $2 WHERE id = $1", [intro.id, outcome]);
  await adjustResponseScore(svc.db, intro.business_id, outcome === "no_reply" ? -0.1 : 0.05);
  const business = await getBusiness(svc.db, intro.business_id);
  if (outcome === "sorted") return t.reply(copy.askRating(intro.id, business?.name ?? "them"));
  if (outcome === "not_yet") return t.reply(copy.notYet(intro.request_id));
  return t.reply(copy.noReply(intro.request_id, intro.business_id));
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

function leadView(l: OnlineLead, request?: RequestRow): LeadView {
  // A lead placed at the searched area (its page didn't say where it is) has no real distance.
  const distanceKm =
    l.area_id != null && request?.lat != null && request.lng != null && l.lat != null && l.lng != null
      ? haversineKm(request.lat, request.lng, l.lat, l.lng)
      : null;
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    areaName: l.area_text,
    distanceKm,
    source: hostOf(l.source_url),
  };
}

function fromPhoto(request?: RequestRow): boolean {
  return request?.raw_text.startsWith(PHOTO_MARK) ?? false;
}

function features(t: T): { photos: boolean; voice: boolean } {
  return { photos: !!t.svc.vision, voice: !!t.svc.speech };
}

function need(i: RequestInterpretation | undefined, category: Category | undefined): string {
  return i?.query || category?.name.toLowerCase() || "that";
}

function resetSearch(state: CustomerState): void {
  state.stage = undefined;
  state.pending = undefined;
  state.pendingText = undefined;
  state.pendingMedia = undefined;
  state.reportBusinessId = undefined;
  state.rec = undefined;
}

function isCommand(text: string, words: string[]): boolean {
  return words.includes(normalizeText(text));
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
