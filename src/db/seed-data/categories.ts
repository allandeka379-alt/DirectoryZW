export type CategoryRisk = "normal" | "high_scam" | "restricted" | "blocked";

export interface CategorySeed {
  slug: string;
  name: string;
  group: string;
  synonyms: string[];
  risk?: CategoryRisk;
  needsLocation?: boolean;
}

/**
 * Taxonomy v1. Synonyms drive the offline keyword interpreter and are shown to Claude.
 * - high_scam: only verified businesses are shown (rentals, cars, visas).
 * - restricted: not searchable until reviewed against WhatsApp's Commerce Policy (health).
 * - blocked: prohibited by WhatsApp's Commerce Policy or Zimbabwean law; always refused.
 */
export const categories: CategorySeed[] = [
  // Electronics and appliances
  { slug: "tv_audio", name: "TVs and audio", group: "Electronics and appliances", synonyms: ["tv", "television", "smart tv", "led tv", "soundbar", "speaker", "home theatre", "decoder", "satellite dish", "dstv"] },
  { slug: "phones", name: "Phones and tablets", group: "Electronics and appliances", synonyms: ["phone", "smartphone", "cellphone", "mobile phone", "iphone", "galaxy", "tablet", "ipad", "itel", "tecno", "infinix"] },
  { slug: "computers", name: "Laptops and computers", group: "Electronics and appliances", synonyms: ["laptop", "computer", "desktop", "pc", "printer", "monitor", "macbook"] },
  { slug: "appliances", name: "Home appliances", group: "Electronics and appliances", synonyms: ["fridge", "refrigerator", "freezer", "stove", "cooker", "microwave", "washing machine", "kettle", "blender", "air conditioner", "aircon"] },
  { slug: "electronics_repair", name: "Phone and electronics repairs", group: "Electronics and appliances", synonyms: ["phone repair", "repair phones", "cracked screen", "screen replacement", "laptop repair", "repair laptops", "tv repair", "fix my phone", "fix phones"] },
  { slug: "appliance_repair", name: "Appliance repairs", group: "Electronics and appliances", synonyms: ["fridge repair", "washing machine repair", "stove repair", "regas", "appliance repair"] },
  // Energy
  { slug: "solar", name: "Solar systems and installers", group: "Energy", synonyms: ["solar", "solar panel", "inverter", "lithium battery", "solar installation", "solar geyser", "solar pump", "solar system"] },
  { slug: "generators", name: "Generators", group: "Energy", synonyms: ["generator", "genset"] },
  { slug: "gas_lpg", name: "Gas (LPG) refills", group: "Energy", synonyms: ["gas", "lpg", "gas refill", "gas cylinder"] },
  // Home services
  { slug: "plumbing", name: "Plumbers", group: "Home services", synonyms: ["plumber", "plumbing", "leak", "burst pipe", "geyser", "blocked drain", "toilet", "tap"] },
  { slug: "electrical", name: "Electricians", group: "Home services", synonyms: ["electrician", "wiring", "rewiring", "db board", "sockets", "power fault"] },
  { slug: "building", name: "Builders and construction", group: "Home services", synonyms: ["builder", "construction", "bricklayer", "renovation", "extension", "plastering", "tiling", "paving", "roofing contractor"] },
  { slug: "painting", name: "Painters", group: "Home services", synonyms: ["painter", "painting", "paint job"] },
  { slug: "carpentry", name: "Carpenters", group: "Home services", synonyms: ["carpenter", "cupboards", "kitchen units", "built-in wardrobe", "doors", "joinery"] },
  { slug: "welding", name: "Welding and steel works", group: "Home services", synonyms: ["welder", "welding", "burglar bars", "gate", "steel frames"] },
  { slug: "cleaning", name: "Cleaning services", group: "Home services", synonyms: ["cleaner", "cleaning", "deep clean", "carpet cleaning", "office cleaning"] },
  { slug: "pest_control", name: "Pest control", group: "Home services", synonyms: ["pest control", "fumigation", "termites", "cockroaches", "rats"] },
  { slug: "gardening", name: "Gardening and landscaping", group: "Home services", synonyms: ["gardener", "garden", "landscaping", "lawn", "tree felling", "weed killer"] },
  { slug: "borehole", name: "Borehole drilling and pumps", group: "Home services", synonyms: ["borehole", "drilling", "water pump", "borehole pump", "siting"] },
  { slug: "water_delivery", name: "Water delivery and tanks", group: "Home services", synonyms: ["water bowser", "water delivery", "water tank", "jojo tank"] },
  { slug: "security", name: "Security services", group: "Home services", synonyms: ["security guard", "alarm", "cctv", "electric fence", "gate motor"] },
  { slug: "laundry", name: "Laundry and dry cleaning", group: "Home services", synonyms: ["laundry", "dry cleaning", "dry cleaner"] },
  // Building and hardware
  { slug: "building_materials", name: "Building materials", group: "Building and hardware", synonyms: ["cement", "bricks", "sand", "river sand", "pit sand", "quarry", "roofing sheets", "ibr", "timber", "rebar", "blocks"] },
  { slug: "hardware", name: "Hardware stores", group: "Building and hardware", synonyms: ["hardware", "tools", "paint", "plumbing fittings", "nails", "electrical fittings", "glue gun", "spray gun"] },
  // Home and furniture
  { slug: "furniture", name: "Furniture", group: "Home and furniture", synonyms: ["furniture", "sofa", "couch", "lounge suite", "bed", "mattress", "wardrobe", "dining table", "office furniture"] },
  { slug: "home_decor", name: "Curtains and home décor", group: "Home and furniture", synonyms: ["curtains", "blinds", "rugs", "carpets", "decor"] },
  // Vehicles and transport
  { slug: "car_repairs", name: "Mechanics and car repairs", group: "Vehicles and transport", synonyms: ["mechanic", "car repair", "car service", "panel beater", "auto electrician", "gearbox"] },
  { slug: "car_parts", name: "Car parts and tyres", group: "Vehicles and transport", synonyms: ["car parts", "spares", "spare parts", "tyres", "tires", "car battery", "exhaust"] },
  { slug: "car_sales", name: "Cars for sale", group: "Vehicles and transport", synonyms: ["car for sale", "buy a car", "used car", "vehicle for sale", "honda fit", "toyota"], risk: "high_scam" },
  { slug: "car_hire", name: "Car hire", group: "Vehicles and transport", synonyms: ["car hire", "car rental", "rent a car", "chauffeur"] },
  { slug: "transport_moving", name: "Trucks, moving and transport", group: "Vehicles and transport", synonyms: ["truck", "lorry", "moving", "removals", "relocation", "haulage", "tipper", "transport goods"] },
  { slug: "courier", name: "Courier and delivery", group: "Vehicles and transport", synonyms: ["courier", "delivery", "parcel", "send a package", "runner"] },
  { slug: "driving_school", name: "Driving schools", group: "Vehicles and transport", synonyms: ["driving school", "driving lessons", "learner's licence"] },
  // Events
  { slug: "event_hire", name: "Event hire (tents, chairs, décor)", group: "Events", synonyms: ["tent hire", "chair hire", "chairs", "tables hire", "decor", "marquee", "pa system", "chair covers"] },
  { slug: "catering", name: "Catering", group: "Events", synonyms: ["caterer", "catering", "braai", "food for event"] },
  { slug: "photography", name: "Photographers and videographers", group: "Events", synonyms: ["photographer", "videographer", "wedding photos", "photoshoot", "video coverage", "drone"] },
  { slug: "venues", name: "Venues", group: "Events", synonyms: ["venue", "wedding venue", "hall", "conference venue", "garden venue"] },
  { slug: "entertainment", name: "DJs, MCs and entertainment", group: "Events", synonyms: ["dj", "mc", "band", "sound system", "entertainment"] },
  { slug: "cakes", name: "Cakes and baking", group: "Events", synonyms: ["cake", "birthday cake", "wedding cake", "cupcakes", "baker"] },
  // Food
  { slug: "groceries", name: "Groceries", group: "Food", synonyms: ["groceries", "grocery", "supermarket", "mealie meal", "cooking oil", "sugar", "rice"] },
  { slug: "butchery", name: "Butcheries", group: "Food", synonyms: ["butchery", "meat", "beef", "chicken", "pork", "goat meat"] },
  { slug: "restaurants", name: "Restaurants and takeaways", group: "Food", synonyms: ["restaurant", "takeaway", "pizza", "sadza", "food delivery"] },
  { slug: "fresh_produce", name: "Fresh produce", group: "Food", synonyms: ["vegetables", "fruit", "tomatoes", "potatoes"] },
  // Fashion and beauty
  { slug: "salons", name: "Hair, beauty and barbers", group: "Fashion and beauty", synonyms: ["salon", "hair", "braids", "wig", "barber", "nails", "makeup", "lashes"] },
  { slug: "clothing", name: "Clothing and shoes", group: "Fashion and beauty", synonyms: ["clothes", "clothing", "dress", "shoes", "sneakers", "school uniform", "suit"] },
  { slug: "tailoring", name: "Tailors and dressmakers", group: "Fashion and beauty", synonyms: ["tailor", "dressmaker", "alterations", "sewing", "wedding dress"] },
  // Property
  { slug: "rentals", name: "Houses and rooms to rent", group: "Property", synonyms: ["house to rent", "room to rent", "flat", "cottage", "rent", "accommodation", "boarding house", "lodgings"], risk: "high_scam" },
  { slug: "property_sales", name: "Property for sale", group: "Property", synonyms: ["house for sale", "stand for sale", "plot", "land for sale", "buy a house"], risk: "high_scam" },
  { slug: "estate_agents", name: "Estate agents", group: "Property", synonyms: ["estate agent", "real estate agent", "property agent"], risk: "high_scam" },
  // Professional services
  { slug: "legal", name: "Lawyers", group: "Professional services", synonyms: ["lawyer", "attorney", "legal advice"], needsLocation: false },
  { slug: "accounting", name: "Accountants and tax", group: "Professional services", synonyms: ["accountant", "bookkeeping", "tax returns", "zimra returns", "audit"], needsLocation: false },
  { slug: "printing", name: "Printing and branding", group: "Professional services", synonyms: ["printing", "branding", "t-shirt printing", "banners", "business cards", "signage"] },
  { slug: "it_services", name: "IT and web services", group: "Professional services", synonyms: ["website", "web design", "it support", "networking", "software developer"], needsLocation: false },
  { slug: "insurance", name: "Insurance", group: "Professional services", synonyms: ["insurance", "car insurance", "funeral cover"], needsLocation: false },
  { slug: "funeral", name: "Funeral services", group: "Professional services", synonyms: ["funeral", "funeral parlour", "coffin", "hearse"] },
  { slug: "travel", name: "Travel agents and bus tickets", group: "Professional services", synonyms: ["travel agent", "flights", "air ticket", "bus ticket", "holiday"], needsLocation: false },
  { slug: "visa_agents", name: "Visa and work-abroad agents", group: "Professional services", synonyms: ["visa", "work permit", "uk visa", "jobs abroad", "study abroad"], risk: "high_scam", needsLocation: false },
  // Education and fitness
  { slug: "tutoring", name: "Tutors and lessons", group: "Education", synonyms: ["tutor", "lessons", "extra lessons", "maths tutor", "o level", "a level"] },
  { slug: "schools", name: "Schools, colleges and creches", group: "Education", synonyms: ["school", "college", "preschool", "creche", "daycare"] },
  { slug: "stationery", name: "Books and stationery", group: "Education", synonyms: ["stationery", "books", "textbooks", "school supplies"] },
  { slug: "gyms", name: "Gyms and fitness", group: "Education", synonyms: ["gym", "fitness", "personal trainer"] },
  // Agriculture
  { slug: "agri_inputs", name: "Farm inputs", group: "Agriculture", synonyms: ["seed", "fertiliser", "fertilizer", "chicks", "day old chicks", "stockfeed", "feed"] },
  { slug: "livestock", name: "Livestock", group: "Agriculture", synonyms: ["cattle", "goats", "broilers", "layers", "pigs", "cows"] },
  { slug: "vets", name: "Vets and pet supplies", group: "Agriculture", synonyms: ["vet", "veterinary", "dog food", "cat food", "pet shop"] },
  // Health: not searchable until checked against WhatsApp's Commerce Policy
  { slug: "pharmacy", name: "Pharmacies", group: "Health", synonyms: ["pharmacy", "chemist", "medicine", "tablets for"], risk: "restricted" },
  { slug: "clinics", name: "Clinics and doctors", group: "Health", synonyms: ["clinic", "doctor", "dentist", "optician"], risk: "restricted" },
  // Blocked: never searchable
  { slug: "blocked_alcohol", name: "Alcohol", group: "Blocked", synonyms: ["alcohol", "beer", "liquor", "whisky", "wine", "bottle store"], risk: "blocked" },
  { slug: "blocked_tobacco", name: "Tobacco and vapes", group: "Blocked", synonyms: ["cigarettes", "tobacco", "vape", "hookah"], risk: "blocked" },
  { slug: "blocked_drugs", name: "Drugs", group: "Blocked", synonyms: ["weed", "marijuana", "dagga", "cannabis", "mbanje", "crystal meth", "mutoriro", "broncleer", "codeine"], risk: "blocked" },
  { slug: "blocked_weapons", name: "Weapons", group: "Blocked", synonyms: ["gun", "firearm", "pistol", "ammunition", "rifle"], risk: "blocked" },
  { slug: "blocked_gambling", name: "Gambling", group: "Blocked", synonyms: ["betting", "gambling", "casino"], risk: "blocked" },
  { slug: "blocked_adult", name: "Adult services and dating", group: "Blocked", synonyms: ["escort", "adult services", "hookup", "dating"], risk: "blocked" },
  { slug: "blocked_lending", name: "Loans", group: "Blocked", synonyms: ["loan", "cash loan", "borrow money", "payday"], risk: "blocked" },
  { slug: "blocked_forex", name: "Currency exchange", group: "Blocked", synonyms: ["forex", "money changer", "change usd", "swap usd", "exchange rate"], risk: "blocked" },
  { slug: "blocked_documents", name: "Fake documents", group: "Blocked", synonyms: ["fake id", "fake passport", "fake certificate", "fake licence"], risk: "blocked" },
  { slug: "blocked_live_animals", name: "Pets and live animals", group: "Blocked", synonyms: ["puppy", "puppies", "dogs for sale", "cats for sale", "parrot"], risk: "blocked" },
];
