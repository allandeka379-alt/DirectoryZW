import type { Action, Family, Role } from "../../ai/lexicon.js";

/**
 * The starting lexicon: what words mean to the local engine, on top of each category's own words.
 *
 * Every word has a role:
 * - service, product: decides the category ("plumber", "keke" = cake)
 * - object, brand, occasion: weak; only decides when nothing stronger is said ("car", "Toyota", "wedding")
 * - action: changes the category of the thing it applies to ("fix" + phone = phone repairs)
 * - spec: neutral detail ("inch", "5kva", "bedroom")
 * - filler: ignored ("please", "ndoda" = I want)
 *
 * The English words were written and checked by the development team, and start approved.
 * The Shona words are the development team's first draft. They start as drafts: until a native
 * speaker approves them in the ops console (Word list), a request that depends on one gets a
 * "Did you mean…?" question instead of a straight answer.
 */
export interface LexiconSeed {
  /** A word or phrase; for verb roots, the root ("gadzir" matches anogadzira, kugadzirisa…). */
  term: string;
  role: Role;
  categories?: string[];
  family?: Family;
  action?: Action;
  root?: boolean;
  /** English meaning, for reviewers. */
  gloss: string;
}

const words =
  (role: Role, categories: string[] = [], family?: Family) =>
  (gloss: string, ...terms: string[]): LexiconSeed[] =>
    terms.map((term) => ({ term, role, categories, family, gloss }));
const product = (categories: string[], family?: Family) => words("product", categories, family);
const service = (categories: string[], family?: Family) => words("service", categories, family);
const object = (categories: string[], family: Family) => words("object", categories, family);
const brand = (categories: string[], family: Family) => words("brand", categories, family);
const occasion = (categories: string[] = []) => words("occasion", categories, "event");
const spec = words("spec");
const filler = words("filler");
const action =
  (act: Action) =>
  (gloss: string, ...terms: string[]): LexiconSeed[] =>
    terms.map((term) => ({ term, role: "action", action: act, gloss }));
/** A verb root, matched with Shona prefixes and endings. */
const verb = (act: Action, root: string, gloss: string): LexiconSeed => ({ term: root, role: "action", action: act, root: true, gloss });
const fillerVerb = (root: string, gloss: string): LexiconSeed => ({ term: root, role: "filler", root: true, gloss });
const productVerb = (categories: string[], root: string, gloss: string): LexiconSeed => ({ term: root, role: "product", categories, root: true, gloss });

const CAR = ["car_sales", "car_parts", "car_repairs"];

export const englishWords: LexiconSeed[] = [
  // ----- Actions -----
  ...action("repair")("repair or fix", "repair", "fix", "mend", "broken", "faulty", "cracked", "servicing", "not working", "doesnt work", "stopped working"),
  ...action("buy")("buy or sell", "buy", "purchase", "sell", "sale", "for sale", "order"),
  ...action("hire")("hire or rent", "hire", "rent", "rental", "for hire", "to let", "lease"),
  ...action("move")("move or carry", "move", "moving", "relocate", "relocating", "transport", "carry"),
  ...action("dig")("dig or drill", "dig", "drill"),
  ...action("build")("build", "build", "construct"),
  ...action("paint")("paint", "paint", "painting", "repaint"),
  ...action("sew")("sew", "sew", "sewing", "stitch"),
  ...action("clean")("clean", "clean", "cleaning"),
  ...action("wash")("wash", "wash", "washing"),
  ...action("cook")("cook", "cook", "cooking"),
  ...action("teach")("teach", "teach", "teaching"),
  ...action("learn")("learn", "learn", "learning"),
  ...action("drive")("drive", "drive", "driving"),
  ...action("send")("send or deliver", "send", "deliver", "delivery"),
  ...action("install")("install", "install", "installation"),
  ...action("print")("print", "print", "printing"),

  // ----- Things that name what's wanted -----
  ...product(["event_hire", "furniture"], "chairs")("chair, which could be to hire or to buy", "chairs", "chair"),
  ...product(["event_hire"], "event_item")("tent", "tent", "tents"),
  ...product(["furniture"], "furniture")("table", "table", "tables"),
  ...product(["car_parts", "solar", "phones"], "battery")("battery", "battery", "batteries"),
  ...product(["tv_audio"], "electronics")("radio", "radio"),
  ...product(["clothing"], "clothes")("clothes", "shirt", "shirts", "t shirt", "t shirts", "trousers", "jeans", "jacket"),
  // Shoes are sold with clothes, but mending them isn't tailoring: "fix my shoes" gets a question.
  ...product(["clothing"], "shoes")("shoes", "shoes", "sneakers", "boots", "sandals"),
  ...product(["car_hire"], "car")("taxi", "taxi", "cab"),
  ...product(["plumbing"])("plumbing problem", "pipe", "pipes", "drain", "sink", "shower"),
  ...product(["electrical"])("electricity", "electricity", "lights"),
  ...service(["pest_control"])("fumigate", "fumigate"),
  ...service(["tutoring"])("school subject", "maths", "math", "mathematics", "physics", "chemistry", "biology", "science", "teacher"),
  ...service(["salons"], "hair")("hair", "haircut", "braid", "plait", "dreadlocks", "dreads", "weave", "relaxer"),

  // ----- Weak words: they only decide when nothing stronger is said -----
  ...object(["car_sales", "car_hire", "car_repairs"], "car")("car", "car", "vehicle", "motor vehicle", "bakkie"),
  ...object(["rentals", "property_sales"], "house")("house or home", "house", "home"),
  ...object(["rentals"], "house")("room", "room"),
  ...object(["building"], "house")("part of a building", "wall", "walls", "roof", "ceiling", "floor"),
  ...object(["property_sales"], "land")("land", "stand", "land"),
  ...object([], "goods")("things to move or send", "stuff", "things", "goods", "luggage", "belongings"),
  ...object(["water_delivery", "borehole"], "water")("water", "water"),
  ...object(["restaurants", "catering", "groceries"], "food")("food", "food", "meals"),
  ...occasion()("an event", "event", "party", "wedding", "birthday", "church", "graduation", "anniversary", "conference", "meeting", "ceremony", "celebration", "baby shower", "kitchen party"),
  ...occasion(["funeral"])("funeral", "funeral", "burial", "memorial"),
  ...brand(CAR, "car")(
    "car make or model",
    "toyota", "honda", "honda fit", "nissan", "mazda", "mercedes", "mercedes benz", "benz", "bmw", "vw", "volkswagen", "ford",
    "isuzu", "mitsubishi", "hyundai", "kia", "corolla", "hilux", "aqua", "vitz", "allion", "premio", "axio", "fielder",
    "sienta", "hiace", "quantum", "prado", "land cruiser", "ranger", "demio", "runx",
  ),
  ...brand(["phones", "tv_audio", "appliances"], "electronics")("electronics brand", "samsung"),
  ...brand(["tv_audio", "appliances"], "electronics")("TV and appliance brand", "lg", "hisense", "philips"),
  ...brand(["tv_audio"], "electronics")("TV and audio brand", "sony", "tcl", "jbl"),
  ...brand(["phones", "computers"], "phone")("phone brand", "apple"),
  ...brand(["phones"], "phone")("phone brand", "huawei", "nokia", "xiaomi", "redmi", "oppo", "vivo"),
  ...brand(["computers"], "computer")("computer brand", "hp", "dell", "lenovo", "acer", "asus", "toshiba", "canon", "epson"),
  ...brand(["appliances"], "appliance")("appliance brand", "defy", "kic", "whirlpool", "bosch"),

  // ----- Details that don't change what's wanted -----
  ...spec(
    "size, amount or kind",
    "inch", "inches", "kva", "kw", "kwh", "watt", "watts", "volt", "volts", "ah", "amp", "amps", "litre", "litres", "liter", "liters",
    "ml", "kg", "kgs", "tonne", "tonnes", "ton", "tons", "bag", "bags", "metre", "metres", "meter", "meters", "cm", "mm", "ft", "feet",
    "bedroom", "bedrooms", "bedroomed", "roomed", "seater", "seaters", "gb", "tb", "ram", "storage", "size", "sizes",
    "colour", "color", "black", "white", "silver", "grey", "gray", "gold", "red", "blue", "green", "pink", "brown",
    "new", "used", "second hand", "secondhand", "brand new", "original", "genuine", "quality", "model", "pro", "max", "plus",
    "mini", "ultra", "series", "pcs", "pieces", "piece", "pair", "pairs", "dozen", "set", "sets", "box", "boxes", "crate",
    "crates", "pack", "packs", "sqm", "acres", "hectares", "guests", "people", "pax", "persons", "kids", "children", "adults",
    "day", "days", "night", "nights", "hour", "hours", "month", "monthly", "big", "small", "large", "medium", "double",
    "single", "queen", "king", "screen", "screens",
  ),
];

export const shonaWords: LexiconSeed[] = [
  // ----- Verbs, by root: kugadzira, anogadzira, vanogadzira, mugadziri… -----
  verb("make", "gadzir", "repair or make (kugadzira, anogadzira, mugadziri)"),
  verb("buy", "teng", "buy or sell (kutenga, kutengesa, mutengesi)"),
  verb("hire", "roj", "rent or hire (kuroja, yekuroja, anorojesa)"),
  verb("move", "takur", "carry, transport (kutakura)"),
  verb("move", "tam", "move house (kutama)"),
  verb("move", "endes", "take something somewhere (kuendesa)"),
  verb("dig", "cher", "dig (kuchera)"),
  verb("build", "vak", "build (kuvaka, muvaki)"),
  verb("paint", "pend", "paint (kupenda, mupendi)"),
  verb("sew", "son", "sew (kusona, musoni)"),
  verb("clean", "chenes", "clean (kuchenesa)"),
  verb("clean", "tsvair", "sweep (kutsvaira)"),
  verb("wash", "wach", "wash clothes (kuwacha, kuwachisa)"),
  verb("cook", "bik", "cook (kubika, mubiki)"),
  verb("teach", "dzidzis", "teach (kudzidzisa, mudzidzisi)"),
  verb("learn", "dzidz", "learn (kudzidza)"),
  verb("drive", "tyair", "drive (kutyaira, mutyairi)"),
  verb("hair", "veur", "cut hair (kuveura)"),
  verb("hair", "ruk", "braid, plait (kuruka)"),
  verb("send", "tumir", "send to (kutumira)"),
  verb("send", "tum", "send (kutuma)"),
  verb("repair", "parar", "break down, get spoilt (kuparara)"),
  verb("repair", "tsemuk", "crack, burst (kutsemuka)"),
  ...action("repair")("it has broken down or died", "yafa", "yakafa", "rafa", "rakafa", "yandifira", "haishande", "harishande", "hazvishande"),
  ...service(["salons"], "hair")("cut hair, barber", "kugera", "anogera", "vanogera", "mugeri"),

  // ----- Electronics and appliances -----
  ...product(["phones"], "phone")("phone", "foni", "mafoni", "nharembozha", "runhare", "chaja", "machaja"),
  ...product(["computers"], "computer")("computer", "komputa", "makomputa", "kombiyuta"),
  ...product(["tv_audio"], "electronics")("TV, radio or speaker", "tivi", "terevhizheni", "redhiyo", "sipika", "masipika", "dhikoda"),
  ...product(["appliances"], "appliance")(
    "fridge, stove or other appliance",
    "firiji", "friji", "furiji", "mafiriji", "chitofu", "zvitofu", "sitovhu", "masitovhu", "ketero", "ayoni",
    "mushini wekuwachisa",
  ),
  // ----- Energy -----
  ...product(["generators"])("generator", "jenareta", "jenereta"),
  ...product(["gas_lpg"])("gas (LPG)", "gasi"),
  ...product(["electrical"])("electricity or wiring", "magetsi", "mawaya"),
  // ----- Home services -----
  ...product(["plumbing"])("tap, pipe, toilet or sink", "pombi", "mapombi", "chimbuzi", "zvimbuzi", "sinki"),
  ...product(["pest_control"])(
    "pests: cockroaches, rats, mice, bedbugs, termites, mosquitoes",
    "mapete", "makonzo", "mbeva", "tsikidzi", "majuru", "zvipembenene", "umhutu",
  ),
  ...product(["gardening"])("garden or grass", "gadheni", "bindu", "uswa", "huswa"),
  ...product(["borehole"], "water")("borehole or well", "chibhorani", "bhorehori", "mugodhi", "tsime"),
  ...product(["water_delivery"], "water")("water tank", "tangi", "matangi"),
  ...object(["water_delivery", "borehole"], "water")("water", "mvura"),
  ...service(["security"])("watchman, guard", "wachimeni"),
  // ----- Building and hardware -----
  ...product(["building_materials"])(
    "cement, bricks, sand, stones or timber",
    "simende", "chidhinha", "zvidhinha", "chidhina", "zvidhina", "jecha", "matombo", "dombo", "mapuranga", "puranga",
  ),
  ...product(["hardware"])("paint, tools or nails", "pendi", "zvishandiso", "zvipikiri", "chipikiri"),
  ...object(["building"], "house")("roof or walls", "denga", "madziro"),
  // ----- Home and furniture -----
  ...product(["event_hire", "furniture"], "chairs")("chair, which could be to hire or to buy", "cheya", "macheya", "chigaro", "zvigaro"),
  ...product(["furniture"], "furniture")(
    "furniture: table, bed, mattress or cupboard",
    "fenicha", "tafura", "matafura", "mubhedha", "mibhedha", "matiresi", "kabati", "makabati",
  ),
  ...product(["home_decor"])("curtains or carpets", "keteni", "maketeni", "kapeti", "makapeti"),
  ...product(["carpentry"], "furniture")("door", "musuwo", "misuwo"),
  ...product(["welding"])("gate", "gedhi", "magedhi"),
  ...object(["rentals", "property_sales"], "house")("house", "imba", "dzimba"),
  ...object(["rentals"], "house")("room", "rumu", "kamuri"),
  ...object(["property_sales"], "land")("stand, plot", "sitendi"),
  // ----- Vehicles and transport -----
  ...object(["car_sales", "car_hire", "car_repairs"], "car")("car", "mota", "motokari"),
  ...product(["transport_moving"], "truck")("lorry, truck", "rori", "marori"),
  ...product(["car_hire", "transport_moving"], "car")("minibus (kombi)", "kombi", "makombi"),
  ...product(["car_hire"], "car")("taxi", "tekisi"),
  ...product(["travel"])("bus, ticket or flight", "bhazi", "mabhazi", "tiketi", "ndege"),
  ...product(["car_parts"], "car_part")("tyre", "tayari", "matayari"),
  ...product(["car_parts", "solar", "phones"], "battery")("battery", "bhatiri", "mabhatiri"),
  ...product(["car_repairs"], "car_part")("engine", "injini"),
  ...service(["car_repairs"])("mechanic", "makanika"),
  ...object([], "goods")("things", "zvinhu"),
  // ----- Events -----
  ...product(["event_hire"], "event_item")("tent", "tende", "matende"),
  ...product(["cakes"])("cake", "keke", "makeke"),
  ...occasion()("an event: wedding, party, bride price ceremony", "muchato", "michato", "mabiko", "roora"),
  ...occasion(["funeral"])("funeral", "mariro"),
  ...service(["entertainment"])("music, singer or band", "mimhanzi", "muimbi", "bhendi"),
  ...service(["venues"])("hall", "horo"),
  ...object(["venues", "rentals"], "house")("a place (for an event, or to stay)", "nzvimbo"),
  ...service(["photography"])("photos or video", "mifananidzo", "mufananidzo", "vhidhiyo"),
  // ----- Food -----
  ...object(["restaurants", "catering", "groceries"], "food")("food", "chikafu", "zvokudya", "zvekudya"),
  ...product(["groceries"], "food")(
    "maize meal, rice, sugar, bread, milk, eggs or salt",
    "hupfu", "upfu", "mupunga", "shuga", "chingwa", "mukaka", "mazai", "munyu",
  ),
  ...product(["butchery"], "food")("meat", "nyama"),
  ...product(["butchery", "livestock"], "food")("chicken", "huku"),
  ...product(["butchery", "groceries"], "food")("fish", "hove"),
  ...product(["fresh_produce"], "food")(
    "vegetables or fruit",
    "muriwo", "mbatatisi", "madomasi", "domasi", "hanyanisi", "michero", "bhanana", "mabhanana",
  ),
  ...product(["agri_inputs"])("chicken feed", "chikafu chehuku"),
  // ----- Agriculture -----
  ...product(["agri_inputs"])("seed, fertiliser or manure", "mbeu", "fetiraiza", "fetireza", "manyowa"),
  ...product(["livestock"])("cattle, goats, pigs or sheep", "mombe", "mbudzi", "nguruve", "hwai", "makwai"),
  ...service(["vets"])("vet, dog food", "chiremba wemhuka", "chiremba wembwa", "chikafu chembwa"),
  // ----- Fashion and beauty -----
  ...product(["clothing"], "clothes")(
    "clothes, shirt, trousers, dress, shoes, socks, hat, jersey, suit or uniform",
    "mbatya", "hembe", "mahembe", "bhurukwa", "rokwe", "marokwe", "masokisi", "ngowani", "juzi", "majuzi", "sutu", "yunifomu",
  ),
  ...product(["clothing"], "shoes")("shoes or boots", "shangu", "bhutsu", "mabhutsu"),
  ...product(["salons"], "hair")("hair, salon, wig or braids", "bvudzi", "saluni", "wigi", "mawigi", "maburaidhi"),
  // ----- Education -----
  ...service(["schools"])("school or creche", "chikoro", "zvikoro", "kireshi"),
  ...service(["driving_school"])("driving school", "chikoro chekutyaira"),
  ...service(["tutoring"])("lessons or mathematics", "zvidzidzo", "chidzidzo", "masvomhu"),
  ...product(["stationery"])("books", "bhuku", "mabhuku"),
  // ----- Professional services -----
  ...service(["legal"])("lawyer", "gweta", "magweta"),
  ...service(["accounting"])("tax", "mutero"),
  ...service(["visa_agents"])("visa", "vhiza"),
  // ----- Health: understood, though not searchable yet -----
  ...service(["clinics"])("doctor, hospital, clinic or nurse", "chiremba", "chipatara", "kiriniki", "mukoti"),
  ...product(["pharmacy"])("medicine", "mushonga", "mishonga"),
  // ----- Never searchable -----
  ...product(["blocked_alcohol"])("beer, alcohol", "doro", "hwahwa"),
  ...product(["blocked_tobacco"])("tobacco, cigarettes", "fodya"),
  ...product(["blocked_lending"])("loan, debt", "chikwereti", "zvikwereti"),
  productVerb(["blocked_lending"], "kweret", "borrow or lend money (kukwereta)"),
  ...product(["blocked_weapons"])("gun", "pfuti"),
  productVerb(["blocked_gambling"], "bhej", "bet (kubheja)"),
  ...product(["blocked_forex"])("change money", "kuchinja mari", "kuchinjana mari"),

  // ----- Details -----
  ...spec(
    "size, colour or amount",
    "diki", "hombe", "nyowani", "chena", "tsvuku", "nhema", "bhegi", "mabhegi", "tani", "matani", "rita", "marita", "saizi", "sikirini",
  ),

  // ----- Fillers: greetings, wanting, looking, small words -----
  ...filler("greeting", "mhoro", "mhoroi", "makadini", "maswera", "mangwanani", "masikati", "manheru", "hesi", "ndeipi", "zvirisei"),
  ...filler("thanks", "ndatenda", "tatenda", "mazvita", "ndinotenda", "maita"),
  ...filler("please, help me", "ndapota", "ndokumbirawo", "ndokumbira", "ndibatsireiwo", "ndibatsirewo", "tibatsireiwo", "tibatsirei"),
  ...filler("I want, we want", "ndoda", "ndinoda", "ndodawo", "ndinodawo", "tinoda", "toda", "tirikuda", "ndaida", "ndingade", "ndingada", "kuda"),
  fillerVerb("tsvag", "look for (kutsvaga, ndirikutsvaga)"),
  fillerVerb("wan", "find, get (kuwana, ndingawanepi)"),
  fillerVerb("gon", "can (anogona)"),
  fillerVerb("kwanis", "be able (anokwanisa)"),
  fillerVerb("ziv", "know (anoziva)"),
  fillerVerb("batsir", "help (kubatsira)"),
  fillerVerb("bvunz", "ask (kubvunza)"),
  fillerVerb("shand", "work (anoshanda)"),
  fillerVerb("bhadhar", "pay (kubhadhara)"),
  fillerVerb("gar", "live, stay (ndinogara)"),
  fillerVerb("tor", "take (anotora)"),
  fillerVerb("uray", "kill (kuuraya), as in pests"),
  ...filler("I live (in)", "ndigere", "agere", "vagere", "tigere"),
  ...filler("do, go, come", "kuita", "anoita", "vanoita", "kuitira", "yekuitira", "zvinoita", "ndoita", "kuenda", "ndoenda", "ndinoenda", "kuuya", "auye", "vauye"),
  ...filler("person, people", "munhu", "vanhu", "mumwe", "vamwe", "murume", "mukadzi", "mwana", "vana"),
  ...filler(
    "my, our, your",
    "yangu", "wangu", "rangu", "changu", "zvangu", "dzangu", "angu", "kwangu", "yedu", "wedu", "redu", "zvedu", "dzedu",
    "yako", "wako", "rako", "yenyu", "wenyu",
  ),
  ...filler("when", "nhasi", "mangwana", "izvozvi", "nezuro", "svondo", "vhiki", "mugovera", "nekukurumidza", "kurumidza", "manje", "zvino", "nguva"),
  ...filler("where, here, near", "kupi", "ndekupi", "papi", "pano", "kuno", "apa", "iko", "uko", "pedyo", "neni"),
  ...filler("price, cheap", "mutengo", "marii", "imarii", "zvakachipa", "yakachipa", "zvinodhura"),
  ...filler("shop, market", "chitoro", "zvitoro", "musika"),
  ...filler(
    "small words: and, but, if, is, there is, which, this, good, all",
    "uye", "asi", "kana", "nekuti", "saka", "futi", "chete", "kuti", "ndine", "handina", "pane", "hapana", "chii", "sei",
    "rini", "ipi", "api", "ndiani", "riri", "iri", "ari", "vari", "zviri", "ndiri", "uri", "tiri", "muri", "ndini", "ndiye",
    "ndizvo", "hongu", "aiwa", "ane", "zvakanaka", "zvakanakisa", "yakanaka", "akanaka", "wakanaka", "yakanakisa",
    "chimwe", "imwe", "rimwe", "zvimwe", "dzimwe", "ichi", "iyi", "uyu", "ava", "izvi", "ino", "idzi", "chinhu", "chero",
    "zvese", "vese", "ese", "dzese", "yese", "kwese", "anogona",
  ),
  ...filler("joining words written apart: of, the plural ma-", "ma", "ye", "re", "che", "dze", "zve", "rwe", "kwe", "ya", "wa", "ra", "cha", "dza", "za", "rwa"),
];
