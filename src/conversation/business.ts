import { one } from "../db/client.js";
import {
  adjustResponseScore,
  businessesOwnedBy,
  claimBusinessesByPhone,
  createBusiness,
  getBusiness,
  setBusinessStatus,
} from "../directory/businesses.js";
import type { Area } from "../directory/gazetteer.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import { getContactById, getRequest, setConsent } from "./store.js";

type Stage = "reg_name" | "reg_what" | "reg_confirm" | "reg_area" | "reg_phone" | "reg_phone_other" | "reg_consent";

export interface BusinessState {
  stage?: Stage;
  draft?: {
    name?: string;
    description?: string;
    categories?: string[];
    keywords?: string;
    areaId?: number;
    lat?: number;
    lng?: number;
    phone?: string;
  };
}

type T = Turn<BusinessState>;

const REGISTER_WORDS = ["register", "list my business", "join", "sign up", "signup", "list", "add my business"];
const YES = ["yes", "y", "yebo", "ehe", "hongu", "correct", "i agree", "agree", "ok", "okay"];

export async function handleBusinessTurn(t: T): Promise<void> {
  const { svc, contact, inbound, state } = t;
  if (contact.is_blocked) return;
  // Businesses a field agent registered become manageable once their number messages us.
  if (contact.phone) await claimBusinessesByPhone(svc.db, contact.id, contact.phone);

  const c = inbound.content;
  if (c.type === "button_reply" || c.type === "list_reply") return onAction(t, c.id);
  if (c.type === "location" && state.stage === "reg_area") {
    return setArea(t, svc.gazetteer.nearest(c.lat, c.lng), c.lat, c.lng);
  }
  if (c.type === "text") {
    const cmd = normalizeText(c.text);
    if (state.stage && ["cancel", "stop"].includes(cmd)) {
      state.stage = undefined;
      state.draft = undefined;
      return t.reply(copy.regCancelled());
    }
    if (state.stage) return continueRegistration(t, c.text);
    if (REGISTER_WORDS.includes(cmd)) return startRegistration(t);
    if (["summary", "stats"].includes(cmd)) return sendSummary(t);
    if (cmd === "pause") return setPaused(t, true);
    if (cmd === "resume") return setPaused(t, false);
    if (cmd === "remove") return t.reply(copy.bizConfirmRemove());
  }
  if (state.stage) return askCurrent(t);
  return showMenu(t);
}

async function onAction(t: T, id: string): Promise<void> {
  const { state, contact } = t;
  const { action, args } = parseAction(id);
  switch (action) {
    case "breg":
      switch (args[0]) {
        case "start":
          return startRegistration(t);
        case "catok":
          if (state.stage !== "reg_confirm") return askCurrent(t);
          state.stage = "reg_area";
          return t.reply(copy.regAskArea());
        case "catchange":
          state.stage = "reg_what";
          return t.reply(copy.regAskWhat());
        case "phonethis":
          if (!state.stage) return showMenu(t);
          if (contact.phone) return setPhone(t, contact.phone);
          state.stage = "reg_phone_other";
          return t.reply(copy.regAskOtherPhone());
        case "phoneother":
          if (!state.stage) return showMenu(t);
          state.stage = "reg_phone_other";
          return t.reply(copy.regAskOtherPhone());
        case "agree":
          return finishRegistration(t);
        default:
          return showMenu(t);
      }
    case "bhow":
      return t.reply(copy.bizHowItWorks(t.svc.config.brandName));
    case "bsum":
      return sendSummary(t);
    case "bpause":
      return setPaused(t, true);
    case "bresume":
      return setPaused(t, false);
    case "bremove":
      return args[0] === "yes" ? removeListing(t) : t.reply(copy.bizConfirmRemove());
    case "aa":
      return askAroundResponse(t, args[0] ?? "", args[1] === "yes");
    default:
      return showMenu(t);
  }
}

async function showMenu(t: T): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  const first = owned[0];
  if (!first) return t.reply(copy.bizWelcome(t.svc.config.brandName));
  return t.reply(copy.bizMenu(first));
}

// ---------- Self-registration ----------

async function startRegistration(t: T): Promise<void> {
  t.state.stage = "reg_name";
  t.state.draft = {};
  return t.reply(copy.regAskName());
}

async function continueRegistration(t: T, text: string): Promise<void> {
  const { svc, state } = t;
  const draft = (state.draft ??= {});
  const value = text.trim();
  switch (state.stage) {
    case "reg_name":
      if (value.length < 2) return t.reply(copy.regAskName());
      draft.name = value.slice(0, 80);
      state.stage = "reg_what";
      return t.reply(copy.regAskWhat());
    case "reg_what": {
      const result = await svc.interpreter.classifyBusiness(value, { taxonomy: svc.taxonomy });
      if (!result.category_slugs.length) return t.reply(copy.regNoCategory());
      draft.description = value.slice(0, 300);
      draft.categories = result.category_slugs;
      draft.keywords = result.keywords;
      state.stage = "reg_confirm";
      const names = result.category_slugs.map((s) => svc.taxonomy.get(s)?.name ?? s);
      return t.reply(copy.regConfirmCategories(names));
    }
    case "reg_confirm":
      if (YES.includes(normalizeText(value))) {
        state.stage = "reg_area";
        return t.reply(copy.regAskArea());
      }
      state.stage = "reg_what";
      return t.reply(copy.regAskWhat());
    case "reg_area": {
      const area = svc.gazetteer.match(value);
      if (!area) return t.reply(copy.regUnknownArea());
      return setArea(t, area, area.lat, area.lng);
    }
    case "reg_phone":
    case "reg_phone_other": {
      const phone = normalizeZimPhone(value);
      if (!phone) return t.reply(copy.regBadPhone());
      return setPhone(t, phone);
    }
    case "reg_consent":
      if (YES.includes(normalizeText(value))) return finishRegistration(t);
      return askCurrent(t);
    default:
      return showMenu(t);
  }
}

async function setArea(t: T, area: Area | undefined, lat: number, lng: number): Promise<void> {
  const draft = (t.state.draft ??= {});
  draft.areaId = area?.id;
  draft.lat = lat;
  draft.lng = lng;
  t.state.stage = "reg_phone";
  return t.reply(copy.regAskPhone());
}

async function setPhone(t: T, phone: string): Promise<void> {
  (t.state.draft ??= {}).phone = phone;
  t.state.stage = "reg_consent";
  return t.reply(copy.regConsent(t.svc.config.businessTermsUrl));
}

async function finishRegistration(t: T): Promise<void> {
  const { svc, state, contact } = t;
  const d = state.draft;
  if (!d?.name || !d.categories?.length || d.lat == null || d.lng == null || !d.phone) return askCurrent(t);
  await createBusiness(svc.db, {
    name: d.name,
    description: d.description,
    keywords: d.keywords,
    phone: d.phone,
    areaId: d.areaId ?? null,
    lat: d.lat,
    lng: d.lng,
    categories: d.categories,
    source: "self",
    ownerContactId: contact.id,
    optedIn: true,
  });
  await setConsent(svc.db, contact.id);
  state.stage = undefined;
  state.draft = undefined;
  svc.log.info({ contactId: contact.id, name: d.name }, "Business self-registered");
  return t.reply(copy.regDone(d.name));
}

async function askCurrent(t: T): Promise<void> {
  const names = (t.state.draft?.categories ?? []).map((s) => t.svc.taxonomy.get(s)?.name ?? s);
  switch (t.state.stage) {
    case "reg_name":
      return t.reply(copy.regAskName());
    case "reg_what":
      return t.reply(copy.regAskWhat());
    case "reg_confirm":
      return t.reply(copy.regConfirmCategories(names));
    case "reg_area":
      return t.reply(copy.regAskArea());
    case "reg_phone":
      return t.reply(copy.regAskPhone());
    case "reg_phone_other":
      return t.reply(copy.regAskOtherPhone());
    case "reg_consent":
      return t.reply(copy.regConsent(t.svc.config.businessTermsUrl));
    default:
      return showMenu(t);
  }
}

// ---------- Listing management ----------

async function sendSummary(t: T): Promise<void> {
  const { svc, contact } = t;
  const owned = await businessesOwnedBy(svc.db, contact.id);
  const b = owned[0];
  if (!b) return t.reply(copy.bizNoListing());
  const since = new Date(svc.now().getTime() - 7 * 24 * 3600_000);
  const stats = await one<{ shown: number; intros: number }>(
    svc.db,
    `SELECT
       (SELECT count(*)::int FROM request_results rr JOIN requests r ON r.id = rr.request_id
         WHERE rr.business_id = $1 AND r.created_at > $2) AS shown,
       (SELECT count(*)::int FROM introductions i WHERE i.business_id = $1 AND i.created_at > $2) AS intros`,
    [b.id, since],
  );
  const avg = b.rating_count > 0 ? b.rating_sum / b.rating_count : null;
  return t.reply(copy.bizSummary(b.name, stats?.shown ?? 0, stats?.intros ?? 0, avg, b.rating_count));
}

async function setPaused(t: T, paused: boolean): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  if (!owned.length) return t.reply(copy.bizNoListing());
  for (const b of owned) await setBusinessStatus(t.svc.db, b.id, paused ? "paused" : "active");
  return t.reply(paused ? copy.bizPaused() : copy.bizResumed());
}

async function removeListing(t: T): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  if (!owned.length) return t.reply(copy.bizNoListing());
  for (const b of owned) await setBusinessStatus(t.svc.db, b.id, "removed");
  return t.reply(copy.bizRemoved());
}

// ---------- Ask-around replies ----------

async function askAroundResponse(t: T, askId: string, yes: boolean): Promise<void> {
  const { svc, contact } = t;
  if (!/^[0-9a-f-]{36}$/i.test(askId)) return showMenu(t);
  const ask = await one<{ id: string; request_id: string; business_id: string; response: string | null }>(
    svc.db,
    "SELECT id, request_id, business_id, response FROM ask_around WHERE id = $1",
    [askId],
  );
  if (!ask) return showMenu(t);
  const business = await getBusiness(svc.db, ask.business_id);
  if (!business || (business.owner_contact_id !== contact.id && business.phone !== contact.phone)) {
    return t.reply(copy.notYourRequest());
  }
  if (ask.response) return t.reply(copy.askAroundAlreadyAnswered());
  await svc.db.query("UPDATE ask_around SET response = $2, responded_at = now() WHERE id = $1", [ask.id, yes ? "yes" : "no"]);
  if (!yes) return t.reply(copy.askAroundNoThanks());

  await adjustResponseScore(svc.db, business.id, 0.05);
  const request = await getRequest(svc.db, ask.request_id);
  const customer = request ? await getContactById(svc.db, request.contact_id) : undefined;
  if (request && customer && !customer.is_blocked) {
    const what = request.raw_text.length > 120 ? `${request.raw_text.slice(0, 119)}…` : request.raw_text;
    const areaName = svc.gazetteer.get(business.area_id)?.name ?? null;
    await svc.messenger.notify(
      "customer",
      customer.wa_id,
      copy.askAroundReplyToCustomer(request.id, business, areaName, what),
      {
        name: svc.config.whatsapp.templates.askAroundReply,
        params: [business.name, what],
        quickReplies: [{ id: Ids.connect(request.id, business.id), title: "Connect me" }],
      },
    );
  }
  return t.reply(copy.askAroundThanks());
}
