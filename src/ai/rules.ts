import type { Action, Family } from "./lexicon.js";

/**
 * The rules that turn words into a category. Few and explicit, each with a test: when the local
 * engine gets something wrong, the fix is a word in the lexicon or a line here.
 */

/** What a category's own words are, so actions can apply to them: a fridge is an appliance. */
export const CATEGORY_FAMILY: Record<string, Family> = {
  phones: "phone",
  computers: "computer",
  tv_audio: "electronics",
  appliances: "appliance",
  car_sales: "car",
  car_parts: "car_part",
  event_hire: "event_item",
  furniture: "furniture",
  home_decor: "furniture",
  rentals: "house",
  property_sales: "house",
  clothing: "clothes",
  salons: "hair",
  groceries: "food",
  restaurants: "food",
  fresh_produce: "food",
  butchery: "food",
  borehole: "water",
  water_delivery: "water",
  courier: "parcel",
  transport_moving: "truck",
};

/** An action applied to a kind of thing: "repair" + a phone is phone repairs, "hire" + chairs is event hire. */
export const RULES: Record<Action, Partial<Record<Family, string>>> = {
  repair: {
    phone: "electronics_repair",
    computer: "electronics_repair",
    electronics: "electronics_repair",
    appliance: "appliance_repair",
    car: "car_repairs",
    car_part: "car_repairs",
    clothes: "tailoring",
    furniture: "carpentry",
    house: "building",
  },
  // Shona "kugadzira" means both to make and to repair: machines get repaired, cakes get made.
  make: {
    phone: "electronics_repair",
    computer: "electronics_repair",
    electronics: "electronics_repair",
    appliance: "appliance_repair",
    car: "car_repairs",
    car_part: "car_repairs",
    clothes: "tailoring",
    furniture: "carpentry",
    house: "building",
  },
  buy: { car: "car_sales", house: "property_sales", land: "property_sales", chairs: "furniture", car_part: "car_parts" },
  hire: {
    car: "car_hire",
    house: "rentals",
    land: "rentals",
    chairs: "event_hire",
    event_item: "event_hire",
    furniture: "event_hire",
    truck: "transport_moving",
    electronics: "event_hire",
  },
  move: {
    goods: "transport_moving",
    furniture: "transport_moving",
    chairs: "transport_moving",
    house: "transport_moving",
    appliance: "transport_moving",
    truck: "transport_moving",
  },
  dig: { water: "borehole" },
  build: { house: "building", land: "building", furniture: "carpentry" },
  paint: { house: "painting", car: "car_repairs" },
  sew: { clothes: "tailoring" },
  clean: { house: "cleaning", furniture: "cleaning", chairs: "cleaning", clothes: "laundry" },
  wash: { clothes: "laundry" },
  cook: { food: "catering" },
  teach: {},
  learn: {},
  drive: {},
  hair: { hair: "salons" },
  send: { parcel: "courier", goods: "courier", food: "restaurants", water: "water_delivery" },
  install: {},
  print: { clothes: "printing" },
};

/**
 * What an action means when nothing in the message says what it's for. Several options mean
 * the customer is asked; none means the engine can't tell. "Learn" and "drive" together leave
 * only driving schools.
 */
export const ACTION_DEFAULTS: Record<Action, string[]> = {
  repair: [],
  make: [],
  buy: [],
  hire: ["rentals", "car_hire", "event_hire"],
  move: ["transport_moving"],
  dig: ["borehole", "building"],
  build: ["building"],
  paint: ["painting"],
  sew: ["tailoring"],
  clean: ["cleaning"],
  wash: ["laundry"],
  cook: ["catering"],
  teach: ["tutoring"],
  learn: ["tutoring", "driving_school", "schools"],
  drive: ["driving_school", "car_hire"],
  hair: ["salons"],
  send: ["courier"],
  install: [],
  print: ["printing"],
};

/**
 * Actions that leave the category alone when nothing else uses them: buying a TV is still TVs,
 * installing solar is still solar, and "kugadzira" a cake is making one.
 */
export const SOFT_ACTIONS = new Set<Action>(["buy", "make", "install"]);

/**
 * Categories a weak word points towards. It narrows a word with several meanings: "bhatiri"
 * (a battery) next to a car brand is car parts, not solar.
 */
export const FAMILY_CONTEXT: Partial<Record<Family, string[]>> = {
  car: ["car_parts", "car_repairs", "car_sales", "car_hire"],
  house: ["rentals", "property_sales", "building", "painting", "cleaning", "home_decor", "furniture", "plumbing", "electrical"],
  land: ["property_sales", "rentals", "building"],
  event: ["venues", "catering", "cakes", "event_hire", "photography", "entertainment", "tailoring"],
  food: ["restaurants", "catering", "groceries", "butchery", "fresh_produce", "cakes"],
  water: ["borehole", "water_delivery", "plumbing"],
  goods: ["transport_moving", "courier"],
};

/**
 * Categories that are services. "Hire a DJ" or "a plumber to fix a leak" still mean the service,
 * so an action nothing used doesn't cast doubt on them the way "fix" + shoes does.
 */
export const SERVICE_CATEGORIES = new Set([
  "electronics_repair", "appliance_repair", "plumbing", "electrical", "building", "painting", "carpentry", "welding",
  "cleaning", "pest_control", "gardening", "borehole", "security", "laundry", "car_repairs", "car_hire",
  "transport_moving", "courier", "driving_school", "event_hire", "catering", "photography", "venues", "entertainment",
  "salons", "tailoring", "estate_agents", "legal", "accounting", "printing", "it_services", "insurance", "funeral",
  "travel", "visa_agents", "tutoring", "schools", "gyms", "vets", "clinics", "solar",
]);
