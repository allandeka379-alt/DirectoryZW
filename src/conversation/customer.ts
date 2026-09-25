import type { RequestInterpretation } from "../ai/types.js";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { adjustResponseScore, getBusiness, recordRating, type Business } from "../directory/businesses.js";
import { haversineKm } from "../directory/gazetteer.js";
import { createIntroduction, getIntroduction, waMeLink } from "../directory/introductions.js";
import { searchBusinesses } from "../directory/search.js";
import type { Category } from "../directory/taxonomy.js";
import { normalizeText } from "../text.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import type { BusinessView } from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import {
  createReport,
  createRequest,
  getRequest,
  saveResults,
  setConsent,
  setRequestStatus,
  type RequestRow,
} from "./store.js";

export interface CustomerState {
  stage?: "awaiting_consent" | "awaiting_area" | "awaiting_report" | "handoff";
  /** First message, kept while we ask for consent. */
  pendingText?: string;
  /** A request waiting for the customer's location. */
  pending?: { raw: string; interpretation: RequestInterpretation };
  lastRequestId?: string;
  lastQuery?: string;
  location?: { lat: number; lng: number; areaId: number | null; label: string };
  reportBusinessId?: string;
}

type T = Turn<CustomerState>;

interface Place {
  areaId: number | null;
  lat: number;
  lng: number;
  label: string;
}

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
      return t.reply(copy.photosNotYet());
    case "audio":
      return t.reply(copy.voiceNotYet());
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
    const pending = state.pendingText;
    state.stage = undefined;
    state.pendingText = undefined;
    if (pending) return onText(t, pending);
    return t.reply(copy.askWhatYouNeed(contact.profile_name));
  }
  if (c.type === "text" && !state.pendingText) state.pendingText = c.text.slice(0, 500);
  state.stage = "awaiting_consent";
  await t.reply(copy.consent(svc.config.brandName, svc.config.privacyUrl, contact.profile_name));
}

async function onText(t: T, text: string): Promise<void> {
  const { svc, state, contact } = t;
  const raw = text.trim();
  if (!raw) return;

  if (isCommand(raw, ["stop", "unsubscribe"])) return t.reply(copy.stopped());
  if (isCommand(raw, ["menu", "start", "restart", "new search"])) {
    resetSearch(state);
    return t.reply(copy.askWhatYouNeed(contact.profile_name));
  }
  if (isCommand(raw, ["help"])) return t.reply(copy.help(svc.config.brandName));

  if (state.stage === "awaiting_report" && state.reportBusinessId) {
    await createReport(svc.db, contact.id, state.reportBusinessId, raw);
    state.stage = undefined;
    state.reportBusinessId = undefined;
    return t.reply(copy.reportThanks());
  }

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

async function onLocation(t: T, lat: number, lng: number): Promise<void> {
  const { svc, state } = t;
  const area = svc.gazetteer.nearest(lat, lng);
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
  if (!hits.length) return t.reply(copy.noResults(request.id, need(interpretation, category), place?.label));
  return t.reply(copy.results(request.id, hits, need(interpretation, category), place?.label));
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
      return t.reply(copy.help(svc.config.brandName));
  }
}

async function showBusiness(t: T, requestId: string, businessId: string): Promise<void> {
  const { svc } = t;
  const business = await getBusiness(svc.db, businessId);
  if (!business || business.status !== "active") return t.reply(copy.noLongerAvailable());
  const request = await ownRequest(t, requestId);
  return t.reply(copy.businessCard(request?.id ?? "", viewOf(t, business, request)));
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
  const rows = await svc.db.query<Business & { rank: number }>(
    `SELECT b.*, rr.rank FROM request_results rr JOIN businesses b ON b.id = rr.business_id
      WHERE rr.request_id = $1 AND b.status = 'active' ORDER BY rr.rank`,
    [request.id],
  );
  const category = svc.taxonomy.get(request.category_slug);
  const place = request.area_id != null ? svc.gazetteer.get(request.area_id)?.name : undefined;
  if (!rows.length) return t.reply(copy.noResults(request.id, need(request.interpretation, category), place));
  return t.reply(copy.results(request.id, rows.map((b) => viewOf(t, b, request)), need(request.interpretation, category), place));
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

function need(i: RequestInterpretation | undefined, category: Category | undefined): string {
  return i?.query || category?.name.toLowerCase() || "that";
}

function resetSearch(state: CustomerState): void {
  state.stage = undefined;
  state.pending = undefined;
  state.pendingText = undefined;
  state.reportBusinessId = undefined;
}

function isCommand(text: string, words: string[]): boolean {
  return words.includes(normalizeText(text));
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
