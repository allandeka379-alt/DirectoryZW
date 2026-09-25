import { one } from "../db/client.js";
import {
  adjustResponseScore,
  businessesOwnedBy,
  claimBusinessesByPhone,
  createBusiness,
  getBusiness,
  setBusinessStatus,
  updateBusinessLocation,
  updateBusinessOffer,
  type Business,
} from "../directory/businesses.js";
import type { Area } from "../directory/gazetteer.js";
import { priceLabel, replaceOfferings, saveBusinessPhoto } from "../directory/offerings.js";
import type { PriceListItem } from "../ai/vision.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import { fetchMedia, hearVoiceNote } from "./media.js";
import { getContactById, getRequest, setConsent } from "./store.js";

type Stage =
  | "reg_name"
  | "reg_what"
  | "reg_confirm"
  | "reg_area"
  | "reg_phone"
  | "reg_phone_other"
  | "reg_consent"
  | "edit_what"
  | "edit_confirm"
  | "edit_area"
  | "price_photo"
  | "price_confirm";

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
  /** Which listing the owner is managing, when they have more than one. */
  selectedBusinessId?: string;
  /** Items read from a price-list photo, waiting for the owner to save them. */
  priceDraft?: { businessId: string; businessName: string; photoId: string; items: PriceListItem[] };
}

type T = Turn<BusinessState>;

const REGISTER_WORDS = ["register", "list my business", "join", "sign up", "signup", "list", "add my business"];
const YES = ["yes", "y", "yebo", "ehe", "hongu", "correct", "i agree", "agree", "ok", "okay", "save"];

export async function handleBusinessTurn(t: T): Promise<void> {
  const { svc, contact, inbound, state } = t;
  if (contact.is_blocked) return;
  // Businesses a field agent registered become manageable once their number messages us.
  if (contact.phone) await claimBusinessesByPhone(svc.db, contact.id, contact.phone);

  let c = inbound.content;
  if (c.type === "button_reply" || c.type === "list_reply") return onAction(t, c.id);
  if (c.type === "location" && (state.stage === "reg_area" || state.stage === "edit_area")) {
    return setArea(t, svc.gazetteer.nearest(c.lat, c.lng), c.lat, c.lng);
  }
  // Price lists arrive as photos; any photo from an owner is read as one.
  if (c.type === "image") return onPriceListPhoto(t, c.mediaId);
  if (c.type === "audio") {
    const heard = await hearVoiceNote(t, c.mediaId);
    if (!heard) return;
    c = { type: "text", text: heard };
  }
  if (c.type === "text") {
    const cmd = normalizeText(c.text);
    if (state.stage && ["cancel", "stop"].includes(cmd)) {
      const wasEditing = !state.stage.startsWith("reg_");
      state.stage = undefined;
      state.draft = undefined;
      state.priceDraft = undefined;
      return wasEditing ? showMenu(t) : t.reply(copy.regCancelled());
    }
    if (state.stage) return continueStage(t, c.text);
    if (REGISTER_WORDS.includes(cmd)) return startRegistration(t);
    if (["prices", "price list", "pricelist", "menu photo"].includes(cmd)) return withBusiness(t, () => askForPriceList(t));
    if (["summary", "stats"].includes(cmd)) return withBusiness(t, (b) => sendSummary(t, b));
    if (cmd === "pause") return withBusiness(t, (b) => setPaused(t, b, true));
    if (cmd === "resume") return withBusiness(t, (b) => setPaused(t, b, false));
    if (cmd === "remove") return withBusiness(t, () => t.reply(copy.bizConfirmRemove()));
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
    case "bedit":
      if (args[0] === "save") return saveOffer(t);
      return withBusiness(t, async () => {
        state.stage = args[0] === "area" ? "edit_area" : "edit_what";
        state.draft = {};
        return t.reply(state.stage === "edit_area" ? copy.regAskArea() : copy.regAskWhat());
      });
    case "bsel": {
      const owned = await businessesOwnedBy(t.svc.db, contact.id);
      if (owned.some((b) => b.id === args[0])) state.selectedBusinessId = args[0];
      return showMenu(t);
    }
    case "bswitch":
      return t.reply(copy.chooseBusiness(await businessesOwnedBy(t.svc.db, contact.id)));
    case "bhow":
      return t.reply(copy.bizHowItWorks(t.svc.config.brandName));
    case "bsum":
      return withBusiness(t, (b) => sendSummary(t, b));
    case "bpause":
      return withBusiness(t, (b) => setPaused(t, b, true));
    case "bresume":
      return withBusiness(t, (b) => setPaused(t, b, false));
    case "bremove":
      return withBusiness(t, (b) => (args[0] === "yes" ? removeListing(t, b) : t.reply(copy.bizConfirmRemove())));
    case "aa":
      return askAroundResponse(t, args[0] ?? "", args[1] === "yes");
    case "bprice":
      if (args[0] === "save") return savePriceList(t);
      return withBusiness(t, () => askForPriceList(t));
    case "bmenu":
      state.stage = undefined;
      state.draft = undefined;
      state.priceDraft = undefined;
      return showMenu(t);
    default:
      return showMenu(t);
  }
}

/** The listing this owner is managing. Asks which one when they have several and haven't picked. */
async function withBusiness(t: T, fn: (b: Business) => Promise<void>): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  if (!owned.length) return t.reply(copy.bizNoListing());
  const business = owned.find((b) => b.id === t.state.selectedBusinessId) ?? (owned.length === 1 ? owned[0] : undefined);
  if (!business) return t.reply(copy.chooseBusiness(owned));
  t.state.selectedBusinessId = business.id;
  return fn(business);
}

async function showMenu(t: T): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  if (!owned.length) return t.reply(copy.bizWelcome(t.svc.config.brandName));
  return withBusiness(t, (b) => t.reply(copy.bizMenu(b, owned.length > 1)));
}

// ---------- Registration and edits ----------

async function startRegistration(t: T): Promise<void> {
  t.state.stage = "reg_name";
  t.state.draft = {};
  return t.reply(copy.regAskName());
}

async function continueStage(t: T, text: string): Promise<void> {
  const { svc, state } = t;
  const draft = (state.draft ??= {});
  const value = text.trim();
  switch (state.stage) {
    case "reg_name":
      if (value.length < 2) return t.reply(copy.regAskName());
      draft.name = value.slice(0, 80);
      state.stage = "reg_what";
      return t.reply(copy.regAskWhat());
    case "reg_what":
    case "edit_what": {
      const result = await svc.interpreter.classifyBusiness(value, { taxonomy: svc.taxonomy });
      if (!result.category_slugs.length) return t.reply(copy.regNoCategory());
      draft.description = value.slice(0, 300);
      draft.categories = result.category_slugs;
      draft.keywords = result.keywords;
      const names = result.category_slugs.map((s) => svc.taxonomy.get(s)?.name ?? s);
      if (state.stage === "edit_what") {
        state.stage = "edit_confirm";
        return t.reply(copy.editConfirmCategories(names));
      }
      state.stage = "reg_confirm";
      return t.reply(copy.regConfirmCategories(names));
    }
    case "reg_confirm":
      if (YES.includes(normalizeText(value))) {
        state.stage = "reg_area";
        return t.reply(copy.regAskArea());
      }
      state.stage = "reg_what";
      return t.reply(copy.regAskWhat());
    case "edit_confirm":
      if (YES.includes(normalizeText(value))) return saveOffer(t);
      state.stage = "edit_what";
      return t.reply(copy.regAskWhat());
    case "reg_area":
    case "edit_area": {
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
    case "price_confirm":
      if (YES.includes(normalizeText(value))) return savePriceList(t);
      return askCurrent(t);
    case "price_photo":
      return askCurrent(t);
    default:
      return showMenu(t);
  }
}

async function setArea(t: T, area: Area | undefined, lat: number, lng: number): Promise<void> {
  if (t.state.stage === "edit_area") {
    return withBusiness(t, async (b) => {
      await updateBusinessLocation(t.svc.db, b.id, { areaId: area?.id ?? null, lat, lng });
      t.state.stage = undefined;
      t.state.draft = undefined;
      return t.reply(copy.listingUpdated(b.name));
    });
  }
  const draft = (t.state.draft ??= {});
  draft.areaId = area?.id;
  draft.lat = lat;
  draft.lng = lng;
  t.state.stage = "reg_phone";
  return t.reply(copy.regAskPhone());
}

async function saveOffer(t: T): Promise<void> {
  const d = t.state.draft;
  if (t.state.stage !== "edit_confirm" || !d?.categories?.length) return showMenu(t);
  return withBusiness(t, async (b) => {
    await updateBusinessOffer(t.svc.db, b.id, {
      description: d.description ?? b.description,
      keywords: d.keywords ?? b.keywords,
      categories: d.categories!,
    });
    t.state.stage = undefined;
    t.state.draft = undefined;
    return t.reply(copy.listingUpdated(b.name));
  });
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
  const id = await createBusiness(svc.db, {
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
  state.selectedBusinessId = id;
  svc.log.info({ contactId: contact.id, name: d.name }, "Business self-registered");
  return t.reply(copy.regDone(d.name));
}

async function askCurrent(t: T): Promise<void> {
  const names = (t.state.draft?.categories ?? []).map((s) => t.svc.taxonomy.get(s)?.name ?? s);
  switch (t.state.stage) {
    case "reg_name":
      return t.reply(copy.regAskName());
    case "reg_what":
    case "edit_what":
      return t.reply(copy.regAskWhat());
    case "reg_confirm":
      return t.reply(copy.regConfirmCategories(names));
    case "edit_confirm":
      return t.reply(copy.editConfirmCategories(names));
    case "reg_area":
    case "edit_area":
      return t.reply(copy.regAskArea());
    case "reg_phone":
      return t.reply(copy.regAskPhone());
    case "reg_phone_other":
      return t.reply(copy.regAskOtherPhone());
    case "reg_consent":
      return t.reply(copy.regConsent(t.svc.config.businessTermsUrl));
    case "price_photo":
      return t.reply(copy.askPriceListPhoto());
    case "price_confirm":
      return t.state.priceDraft ? t.reply(priceListMessage(t.state.priceDraft.items, t.state.priceDraft.businessName)) : showMenu(t);
    default:
      return showMenu(t);
  }
}

// ---------- Price lists ----------

async function askForPriceList(t: T): Promise<void> {
  t.state.stage = "price_photo";
  t.state.draft = undefined;
  t.state.priceDraft = undefined;
  return t.reply(copy.askPriceListPhoto());
}

/** Read a price-list photo and show the owner what we read before saving anything. */
async function onPriceListPhoto(t: T, mediaId: string): Promise<void> {
  const { svc, state } = t;
  if (state.stage && state.stage !== "price_photo" && state.stage !== "price_confirm") return askCurrent(t);
  return withBusiness(t, async (b) => {
    if (!svc.vision) return t.reply(copy.bizPhotosUnavailable());
    const image = await fetchMedia(t, mediaId);
    if (!image) return;
    const list = await svc.vision.readPriceList(image);
    if (!list?.is_price_list || !list.items.length) {
      state.stage = "price_photo";
      return t.reply(copy.priceListUnreadable());
    }
    const photoId = await saveBusinessPhoto(svc.db, svc.store, b.id, "price_list", image);
    state.stage = "price_confirm";
    state.priceDraft = { businessId: b.id, businessName: b.name, photoId, items: list.items };
    return t.reply(priceListMessage(list.items, b.name));
  });
}

function priceListMessage(items: PriceListItem[], businessName: string) {
  return copy.priceListRead(businessName, items.map((i) => ({ name: i.name, price: priceLabel(i) })));
}

async function savePriceList(t: T): Promise<void> {
  const draft = t.state.priceDraft;
  if (t.state.stage !== "price_confirm" || !draft) return showMenu(t);
  return withBusiness(t, async (b) => {
    if (b.id !== draft.businessId) return showMenu(t);
    await replaceOfferings(t.svc.db, b.id, draft.items, draft.photoId);
    t.state.stage = undefined;
    t.state.priceDraft = undefined;
    return t.reply(copy.priceListSaved(b.name, draft.items.length));
  });
}

// ---------- Listing management ----------

async function sendSummary(t: T, b: Business): Promise<void> {
  const { svc } = t;
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

async function setPaused(t: T, b: Business, paused: boolean): Promise<void> {
  await setBusinessStatus(t.svc.db, b.id, paused ? "paused" : "active");
  return t.reply(paused ? copy.bizPaused() : copy.bizResumed());
}

async function removeListing(t: T, b: Business): Promise<void> {
  await setBusinessStatus(t.svc.db, b.id, "removed");
  t.state.selectedBusinessId = undefined;
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
