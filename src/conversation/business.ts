import { one } from "../db/client.js";
import {
  businessesOwnedBy,
  claimBusinessesByPhone,
  createBusiness,
  setBusinessStatus,
  updateBusinessLocation,
  updateBusinessOffer,
  type Business,
} from "../directory/businesses.js";
import type { Area } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { eraseBusiness, eraseContact } from "../privacy.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import { Ids, parseAction } from "./ids.js";
import { ERASE_WORDS } from "./customer.js";
import { setConsent } from "./store.js";

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
}

type T = Turn<BusinessState>;

const REGISTER_WORDS = ["register", "list my business", "join", "sign up", "signup", "list", "add my business"];
const YES = ["yes", "y", "yebo", "ehe", "hongu", "correct", "i agree", "agree", "ok", "okay", "save"];

export async function handleBusinessTurn(t: T): Promise<void> {
  const { svc, contact, inbound, state } = t;
  if (contact.is_blocked) return;
  // Businesses a field agent registered become manageable once their number messages us.
  if (contact.phone) await claimBusinessesByPhone(svc.db, contact.id, contact.phone);

  const c = inbound.content;
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
    if (state.stage) return continueStage(t, c.text);
    if (REGISTER_WORDS.includes(cmd)) return startRegistration(t);
    if (["summary", "stats"].includes(cmd)) return withBusiness(t, (b) => sendSummary(t, b));
    if (["customers", "my customers", "leads"].includes(cmd)) return withBusiness(t, (b) => showCustomers(t, b));
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

// ---------- Deleting their data ----------

/** The owner asked us to forget them: their chats and every listing they manage. */
async function eraseEverything(t: T): Promise<void> {
  const { svc, contact } = t;
  const owned = await businessesOwnedBy(svc.db, contact.id);
  await t.reply(copy.bizErased());
  t.defer(async () => {
    for (const b of owned) await eraseBusiness(svc.db, svc.store, b.id);
    const result = await eraseContact(svc.db, contact.id);
    svc.log.info({ ...result, listings: owned.length }, "Business owner deleted their data");
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
