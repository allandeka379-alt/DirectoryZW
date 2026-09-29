import { one } from "../db/client.js";
import {
  businessesOwnedBy,
  claimBusinessesByPhone,
  createBusiness,
  setBusinessStatus,
  setBusinessTrade,
  TRADES,
  updateBusinessLocation,
  updateBusinessOffer,
  type Business,
} from "../directory/businesses.js";
import type { Area } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { eraseBusiness, eraseContact } from "../privacy.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import { createLoginLink, signInUrl } from "../web/owner-auth.js";
import { completeWebRegistration, REGISTRATION_CODE } from "../web/registration.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import { ERASE_WORDS, handleCustomerTurn, type CustomerState } from "./customer.js";
import { DASHBOARD, isRegisterIntent, MY_BUSINESS } from "./router.js";
import { otherSide, setConsent } from "./store.js";

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
  | "edit_area";

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
  /**
   * The owner is looking for supplies for this business. Their messages then go through the
   * customer flow (which shares this state), searching businesses that sell wholesale.
   */
  buying?: { businessId: string; name: string };
}

type T = Turn<BusinessState>;

const REGISTER_WORDS = ["register", "list my business", "join", "sign up", "signup", "list", "add my business"];
const SUPPLIER_WORDS = ["find a supplier", "find supplier", "suppliers", "supplier", "wholesale", "wholesalers", "buy stock", "restock"];
/** Leave a supplier search for the business menu. */
const LEAVE_BUYING = ["menu", "cancel", "stop", "back", "exit"];
/** Taps on supplier results, cards and follow-ups: the customer flow's actions, on this number. */
const BUYER_ACTIONS = new Set(["biz", "con", "list", "human", "new", "rep", "fb", "rate", "notit", "mean"]);
const YES = ["yes", "y", "yebo", "ehe", "hongu", "correct", "i agree", "agree", "ok", "okay", "save"];

export async function handleBusinessTurn(t: T): Promise<void> {
  const { svc, contact, inbound, state } = t;
  if (contact.is_blocked) return;
  // Businesses a field agent registered become manageable once their number messages us.
  if (contact.phone) await claimBusinessesByPhone(svc.db, contact.id, contact.phone);

  const c = inbound.content;
  // Finishing a registration started on the website, or asking for a dashboard link, whatever else was going on.
  if (c.type === "text" && REGISTRATION_CODE.test(c.text)) return finishWebRegistration(t, c.text);
  if (c.type === "text" && DASHBOARD.has(normalizeText(c.text))) return sendDashboardLink(t);
  // Looking for supplies: the customer flow runs on this number, for the owner's business.
  if ((c.type === "button_reply" || c.type === "list_reply") && BUYER_ACTIONS.has(parseAction(c.id).action)) return asBuyer(t);
  if (state.buying) {
    const said = c.type === "text" ? normalizeText(c.text) : "";
    if (LEAVE_BUYING.includes(said) || MY_BUSINESS.has(said)) {
      stopBuying(t);
      return showMenu(t);
    }
    if (isRegisterIntent(said)) {
      stopBuying(t);
      return startRegistration(t);
    }
    if (c.type === "text" && !ERASE_WORDS.includes(said)) return asBuyer(t);
    if (c.type === "location") return asBuyer(t);
    // Anything else (a business menu button, "delete my data") ends the search and is handled below.
    stopBuying(t);
  }
  if (c.type === "button_reply" || c.type === "list_reply") return onAction(t, c.id);
  if (c.type === "location" && (state.stage === "reg_area" || state.stage === "edit_area")) {
    return setArea(t, svc.gazetteer.nearest(c.lat, c.lng), c.lat, c.lng);
  }
  // Typed messages only, for now: voice notes and photos aren't read.
  if (c.type === "image" || c.type === "audio") return t.reply(copy.bizTypeInstead());
  if (c.type === "text") {
    const cmd = normalizeText(c.text);
    if (state.stage && ["cancel", "stop"].includes(cmd)) {
      const wasEditing = !state.stage.startsWith("reg_");
      state.stage = undefined;
      state.draft = undefined;
      return wasEditing ? showMenu(t) : t.reply(copy.regCancelled());
    }
    if (ERASE_WORDS.includes(cmd)) {
      const owned = await businessesOwnedBy(svc.db, contact.id);
      return t.reply(copy.bizEraseConfirm(owned.map((b) => b.name)));
    }
    // "I want to register a business" starts afresh, even halfway through something else.
    if (isRegisterIntent(cmd)) return startRegistration(t);
    if (MY_BUSINESS.has(cmd)) {
      state.stage = undefined;
      state.draft = undefined;
      return showMenu(t);
    }
    if (state.stage) return continueStage(t, c.text);
    if (REGISTER_WORDS.includes(cmd)) return startRegistration(t);
    if (["summary", "stats"].includes(cmd)) return withBusiness(t, (b) => sendSummary(t, b));
    if (["customers", "my customers", "leads"].includes(cmd)) return withBusiness(t, (b) => showCustomers(t, b));
    if (SUPPLIER_WORDS.includes(cmd)) return withBusiness(t, (b) => startBuying(t, b));
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
          // Pick the category by hand; a new description still works too.
          state.stage = state.stage?.startsWith("edit_") ? "edit_what" : "reg_what";
          return t.reply(copy.pickGroup(businessGroups(t.svc.taxonomy), 0));
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
    case "bleads":
      return withBusiness(t, (b) => showCustomers(t, b));
    case "bbuy":
      return withBusiness(t, (b) => startBuying(t, b));
    case "btrade":
      return withBusiness(t, async (b) => {
        const trade = TRADES.find((x) => x === args[0]);
        if (!trade) return t.reply(copy.askTrade(b.trade));
        await setBusinessTrade(t.svc.db, b.id, trade);
        return t.reply(copy.tradeSaved(b.name, trade));
      });
    case "bpause":
      return withBusiness(t, (b) => setPaused(t, b, true));
    case "bresume":
      return withBusiness(t, (b) => setPaused(t, b, false));
    case "bremove":
      return withBusiness(t, (b) => (args[0] === "yes" ? removeListing(t, b) : t.reply(copy.bizConfirmRemove())));
    case "bpick":
      return pickCategoryStep(t, args);
    case "erase":
      if (args[0] !== "yes") return showMenu(t);
      return eraseEverything(t);
    case "bmenu":
      state.stage = undefined;
      state.draft = undefined;
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
  return withBusiness(t, async (b) => t.reply(copy.bizMenu(b, owned.length > 1, await weekStats(t, b))));
}

/** Searches the business showed up in, and customers who contacted it, in the last 7 days. */
async function weekStats(t: T, b: Business): Promise<{ shown: number; intros: number }> {
  const since = new Date(t.svc.now().getTime() - 7 * 24 * 3600_000);
  const stats = await one<{ shown: number; intros: number }>(
    t.svc.db,
    `SELECT
       (SELECT count(*)::int FROM request_results rr JOIN requests r ON r.id = rr.request_id
         WHERE rr.business_id = $1 AND r.created_at > $2) AS shown,
       (SELECT count(*)::int FROM introductions i WHERE i.business_id = $1 AND i.created_at > $2) AS intros`,
    [b.id, since],
  );
  return { shown: stats?.shown ?? 0, intros: stats?.intros ?? 0 };
}

/** The last 30 days' customers, by reference code, newest first. */
async function showCustomers(t: T, b: Business): Promise<void> {
  const leads = await t.svc.db.query<{ ref: string; at: Date; what: string | null; outcome: string | null }>(
    `SELECT i.ref_code AS ref, i.created_at AS at, r.raw_text AS what, i.outcome
       FROM introductions i LEFT JOIN requests r ON r.id = i.request_id
      WHERE i.business_id = $1 AND i.created_at > now() - interval '30 days'
      ORDER BY i.created_at DESC LIMIT 15`,
    [b.id],
  );
  return t.reply(copy.myCustomers(b.name, leads.map((l) => ({ ...l, at: new Date(l.at) }))));
}

// ---------- Looking for suppliers ----------

/** The shared state, seen as the customer flow sees it. */
function asCustomerState(t: T): CustomerState {
  return t.state as unknown as CustomerState;
}

/** Start a supplier search for this business, near where it is. */
async function startBuying(t: T, b: Business): Promise<void> {
  beginBuying(t, b);
  return t.reply(copy.askWhatToBuy(b.name, t.svc.gazetteer.get(b.area_id)?.name ?? null));
}

function beginBuying(t: T, b: Business): void {
  t.state.stage = undefined;
  t.state.draft = undefined;
  const s = asCustomerState(t);
  s.stage = undefined;
  s.pending = undefined;
  s.choice = undefined;
  s.unclear = undefined;
  s.buying = { businessId: b.id, name: b.name };
  // Suppliers near the business, without asking where.
  if (b.lat != null && b.lng != null) {
    s.location = { areaId: b.area_id, lat: b.lat, lng: b.lng, label: t.svc.gazetteer.get(b.area_id)?.name ?? "your business" };
  }
}

function stopBuying(t: T): void {
  const s = asCustomerState(t);
  s.buying = undefined;
  s.stage = undefined;
  s.pending = undefined;
  s.choice = undefined;
  s.unclear = undefined;
  s.location = undefined;
}

/**
 * Hand the message to the customer flow, as the owner's business. A tap on an older supplier
 * result or follow-up starts the search mode again for the business they're managing.
 */
async function asBuyer(t: T): Promise<void> {
  const { svc, contact } = t;
  if (!t.state.buying) {
    const owned = await businessesOwnedBy(svc.db, contact.id);
    const b = owned.find((x) => x.id === t.state.selectedBusinessId) ?? owned[0];
    if (!b) return t.reply(copy.bizNoListing());
    beginBuying(t, b);
  }
  // Owners agreed to the listing terms when they registered (or with the field agent).
  if (!contact.consent_at) {
    await setConsent(svc.db, contact.id);
    contact.consent_at = svc.now();
  }
  return handleCustomerTurn(t as unknown as Turn<CustomerState>);
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
      // Local keywords only; when they don't fit, the owner picks from a list. No Claude call.
      const result = await svc.keywords.classifyBusiness(value, { taxonomy: svc.taxonomy, lexicon: svc.lexicon });
      draft.description = value.slice(0, 300);
      draft.keywords = result.keywords;
      if (!result.category_slugs.length) {
        return t.reply(copy.pickGroup(businessGroups(svc.taxonomy), 0, "I couldn't tell from that. Which of these best describes your business?"));
      }
      draft.categories = result.category_slugs;
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
      const area = svc.gazetteer.match(value, { fuzzy: true });
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
    default:
      return showMenu(t);
  }
}

// ---------- The web dashboard ----------

async function dashboardUrl(t: T): Promise<string> {
  const token = await createLoginLink(t.svc.db, t.contact.id, t.svc.now());
  return signInUrl(t.svc.config.publicBaseUrl, token);
}

/** A one-time sign-in link for the owner's web dashboard, sent in this chat (free: they just wrote to us). */
async function sendDashboardLink(t: T): Promise<void> {
  const owned = await businessesOwnedBy(t.svc.db, t.contact.id);
  if (!owned.length) return t.reply(copy.bizNoListing());
  return t.reply(copy.dashboardLink(await dashboardUrl(t)));
}

/** The owner sent the code shown after registering on the website: create the listing, owned by this number. */
async function finishWebRegistration(t: T, text: string): Promise<void> {
  const { svc, contact, state } = t;
  const result = await completeWebRegistration({ db: svc.db, gazetteer: svc.gazetteer }, text, contact.id, svc.now());
  if (!("businessId" in result)) return t.reply(copy.webRegProblem(result.status, `${svc.config.publicBaseUrl}/register`));
  await setConsent(svc.db, contact.id);
  state.stage = undefined;
  state.draft = undefined;
  state.selectedBusinessId = result.businessId;
  if (result.status === "created") svc.log.info({ contactId: contact.id, name: result.name }, "Business registered on the website");
  const url = await dashboardUrl(t);
  return t.reply(result.status === "created" ? copy.webRegDone(result.name, url) : copy.webRegAlready(result.name, url));
}

// ---------- Deleting their data ----------

/** The owner asked us to forget them: their chats (as a customer too) and every listing they manage. */
async function eraseEverything(t: T): Promise<void> {
  const { svc, contact } = t;
  const owned = await businessesOwnedBy(svc.db, contact.id);
  await t.reply(copy.bizErased());
  t.defer(async () => {
    for (const b of owned) await eraseBusiness(svc.db, svc.store, b.id);
    // Their products leave the WhatsApp catalog at the next sync, straight away.
    if (owned.length && svc.catalog) await svc.jobs.enqueueOnce("catalog_sync", "all", {}, svc.now());
    const result = await eraseContact(svc.db, contact.id);
    const asCustomer = await otherSide(svc.db, contact);
    if (asCustomer) await eraseContact(svc.db, asCustomer.id);
    svc.log.info({ ...result, listings: owned.length, alsoCustomer: Boolean(asCustomer) }, "Business owner deleted their data");
  });
}

// ---------- Listing management ----------

async function sendSummary(t: T, b: Business): Promise<void> {
  const week = await weekStats(t, b);
  const avg = b.rating_count > 0 ? b.rating_sum / b.rating_count : null;
  return t.reply(copy.bizSummary(b.name, week.shown, week.intros, avg, b.rating_count));
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

// ---------- Choosing a category by hand ----------

/** Kinds of business an owner can list under, alphabetically. */
function businessGroups(taxonomy: Taxonomy): string[] {
  return [...new Set(taxonomy.searchable().map((c) => c.group))].sort((a, b) => a.localeCompare(b));
}

/** The picker's steps: a page of kinds of business ("g"), one kind's categories ("c"), a chosen category ("s"). */
async function pickCategoryStep(t: T, args: string[]): Promise<void> {
  const { svc, state } = t;
  const choosing = ["reg_what", "reg_confirm", "edit_what", "edit_confirm"];
  if (!state.stage || !choosing.includes(state.stage)) return askCurrent(t);
  const editing = state.stage.startsWith("edit_");
  const groups = businessGroups(svc.taxonomy);
  const [step, first, second] = args;
  if (step === "c") {
    const index = Number(first);
    const group = groups[index];
    if (!group) return t.reply(copy.pickGroup(groups, 0));
    const categories = svc.taxonomy
      .searchable()
      .filter((c) => c.group === group)
      .sort((a, b) => a.name.localeCompare(b.name));
    return t.reply(copy.pickCategory(group, index, categories, Number(second) || 0));
  }
  if (step === "s") {
    const category = svc.taxonomy.get(first);
    if (!category || category.risk === "blocked" || category.risk === "restricted") return t.reply(copy.pickGroup(groups, 0));
    (state.draft ??= {}).categories = [category.slug];
    state.stage = editing ? "edit_confirm" : "reg_confirm";
    return t.reply(editing ? copy.editConfirmCategories([category.name]) : copy.regConfirmCategories([category.name]));
  }
  return t.reply(copy.pickGroup(groups, Number(first) || 0));
}
