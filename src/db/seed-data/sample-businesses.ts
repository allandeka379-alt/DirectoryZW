export interface SampleBusiness {
  name: string;
  area: string;
  categories: string[];
  description: string;
  keywords?: string;
  verified: boolean;
}

/**
 * Fictional businesses for local development and demos only. Phone numbers are
 * generated in the unused 26377000xxxx range. Never load these in production.
 */
export const sampleBusinesses: SampleBusiness[] = [
  { name: "Avondale Electronics (sample)", area: "Avondale", categories: ["tv_audio", "appliances"], description: "TVs, sound systems, fridges and stoves. Delivery in Harare.", keywords: "samsung lg hisense 55 inch 65 inch", verified: true },
  { name: "Gulf Tech Traders (sample)", area: "Harare CBD", categories: ["tv_audio", "phones", "computers"], description: "Phones, laptops and TVs at Gulf Complex.", keywords: "samsung iphone hp dell 43 inch 55 inch", verified: true },
  { name: "Borrowdale Home Appliances (sample)", area: "Borrowdale", categories: ["appliances"], description: "Fridges, freezers, washing machines, microwaves.", keywords: "defy lg samsung 300 litre fridge", verified: true },
  { name: "Eastlea Phone Hub (sample)", area: "Eastlea", categories: ["phones", "electronics_repair"], description: "New and refurbished phones, screen replacements while you wait.", keywords: "iphone samsung tecno itel", verified: false },
  { name: "SunPower Solar Harare (sample)", area: "Msasa", categories: ["solar"], description: "Solar systems from 1kVA to 10kVA, inverters, lithium batteries, installation.", keywords: "5kva inverter lithium battery panels geyser", verified: true },
  { name: "Mabelreign Solar Fitters (sample)", area: "Mabelreign", categories: ["solar", "electrical"], description: "Solar installation and electrical wiring for homes.", keywords: "inverter installation wiring", verified: false },
  { name: "Brightside Solar Bulawayo (sample)", area: "Hillside", categories: ["solar"], description: "Solar kits and installation in Bulawayo.", keywords: "inverter battery panels", verified: true },
  { name: "QuickFix Plumbing (sample)", area: "Mabelreign", categories: ["plumbing"], description: "Leaks, burst pipes, geysers and blocked drains. Same-day call-outs.", keywords: "geyser installation", verified: true },
  { name: "Waterfalls Plumbers (sample)", area: "Waterfalls", categories: ["plumbing"], description: "Plumbing repairs and installations.", verified: false },
  { name: "Hatfield Plumbing Works (sample)", area: "Hatfield", categories: ["plumbing", "borehole"], description: "Plumbing, borehole pumps and water tanks.", verified: true },
  { name: "PowerLine Electricians (sample)", area: "Belvedere", categories: ["electrical"], description: "House wiring, DB boards and fault finding.", verified: true },
  { name: "Glen View Furniture Makers (sample)", area: "Glen View", categories: ["furniture", "carpentry"], description: "Lounge suites, beds, wardrobes and kitchen units made to order.", keywords: "sofa bed wardrobe", verified: true },
  { name: "Budiriro Couches (sample)", area: "Budiriro", categories: ["furniture"], description: "Affordable couches and beds.", verified: false },
  { name: "Siyaso Hardware (sample)", area: "Mbare", categories: ["hardware", "building_materials"], description: "Cement, roofing sheets, tools and fittings.", keywords: "cement roofing ibr", verified: true },
  { name: "Southerton Building Supplies (sample)", area: "Southerton", categories: ["building_materials"], description: "Bricks, river sand, pit sand, quarry stones delivered.", keywords: "bricks sand quarry delivery", verified: true },
  { name: "Ruwa Builders (sample)", area: "Ruwa", categories: ["building"], description: "House construction, extensions, tiling and plastering.", verified: false },
  { name: "Msasa Event Hire (sample)", area: "Msasa", categories: ["event_hire"], description: "Tents, chairs, tables and décor for weddings and parties.", keywords: "100 chairs tent marquee", verified: true },
  { name: "Chitungwiza Tents & Chairs (sample)", area: "Chitungwiza", categories: ["event_hire"], description: "Tent and chair hire in Chitungwiza.", verified: false },
  { name: "Lens & Light Photography (sample)", area: "Mount Pleasant", categories: ["photography"], description: "Wedding photography and video coverage.", keywords: "wedding drone video", verified: true },
  { name: "Sweet Layers Cakes (sample)", area: "Avondale", categories: ["cakes"], description: "Birthday and wedding cakes to order.", verified: true },
  { name: "Highfield Caterers (sample)", area: "Highfield", categories: ["catering"], description: "Catering for weddings, funerals and parties.", verified: false },
  { name: "Workington Truck Hire (sample)", area: "Workington", categories: ["transport_moving"], description: "Trucks for moving and deliveries in Harare and long distance.", keywords: "harare bulawayo 5 tonne", verified: true },
  { name: "CityMove Removals (sample)", area: "Belgravia", categories: ["transport_moving"], description: "House and office removals.", verified: false },
  { name: "Arcadia Auto Repairs (sample)", area: "Arcadia", categories: ["car_repairs"], description: "Car servicing, gearbox and auto electrics.", keywords: "honda fit toyota service", verified: true },
  { name: "Kuwadzana Tyres & Spares (sample)", area: "Kuwadzana", categories: ["car_parts"], description: "Tyres, batteries and spares.", verified: false },
  { name: "Greendale Rentals (sample)", area: "Greendale", categories: ["rentals", "estate_agents"], description: "Houses and cottages to rent in eastern suburbs.", keywords: "2 bedroom cottage", verified: true },
  { name: "Budget Rooms Epworth (sample)", area: "Epworth", categories: ["rentals"], description: "Rooms to rent.", verified: false },
  { name: "Glam Studio Salon (sample)", area: "Harare CBD", categories: ["salons"], description: "Braids, wigs, nails and makeup.", verified: true },
  { name: "Mbare Fresh Market Stall (sample)", area: "Mbare", categories: ["fresh_produce"], description: "Vegetables and fruit wholesale.", verified: false },
  { name: "PrintIt Branding (sample)", area: "Milton Park", categories: ["printing"], description: "T-shirt printing, banners, business cards and signage.", verified: true },
  { name: "Maths Made Easy Tutors (sample)", area: "Marlborough", categories: ["tutoring"], description: "O and A level maths and science lessons.", verified: false },
  { name: "Hillside Borehole Drillers (sample)", area: "Burnside", categories: ["borehole"], description: "Borehole siting, drilling and pumps in Bulawayo.", verified: true },
  { name: "Mutare Gas Refills (sample)", area: "Mutare", categories: ["gas_lpg"], description: "LPG gas refills and cylinders.", verified: false },
  { name: "Chisipite Pest Control (sample)", area: "Chisipite", categories: ["pest_control"], description: "Fumigation for termites, cockroaches and rats.", verified: true },
];
