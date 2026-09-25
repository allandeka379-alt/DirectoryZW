export interface AreaSeed {
  name: string;
  city: string;
  lat: number;
  lng: number;
  aliases?: string[];
}

/**
 * Suburb and town centroids. Coordinates are approximate (to about 1 km) and should be
 * refined from field-team GPS pins. City-level rows (name = city) catch "in Harare" etc.
 */
export const areas: AreaSeed[] = [
  // Harare
  { name: "Harare", city: "Harare", lat: -17.8292, lng: 31.0522, aliases: ["hre"] },
  { name: "Harare CBD", city: "Harare", lat: -17.8292, lng: 31.0522, aliases: ["cbd", "town", "city centre", "downtown", "gulf complex", "kwame nkrumah"] },
  { name: "Avondale", city: "Harare", lat: -17.796, lng: 31.037, aliases: ["avondale shops"] },
  { name: "Borrowdale", city: "Harare", lat: -17.756, lng: 31.099, aliases: ["sam levy", "sam levys", "borrowdale village"] },
  { name: "Borrowdale Brooke", city: "Harare", lat: -17.73, lng: 31.14 },
  { name: "Mount Pleasant", city: "Harare", lat: -17.771, lng: 31.048, aliases: ["mt pleasant"] },
  { name: "Belgravia", city: "Harare", lat: -17.811, lng: 31.046 },
  { name: "Milton Park", city: "Harare", lat: -17.815, lng: 31.028 },
  { name: "Belvedere", city: "Harare", lat: -17.829, lng: 31.027, aliases: ["longcheng"] },
  { name: "Eastlea", city: "Harare", lat: -17.828, lng: 31.075 },
  { name: "Highlands", city: "Harare", lat: -17.795, lng: 31.093 },
  { name: "Newlands", city: "Harare", lat: -17.804, lng: 31.087 },
  { name: "Chisipite", city: "Harare", lat: -17.788, lng: 31.118 },
  { name: "Greystone Park", city: "Harare", lat: -17.756, lng: 31.127 },
  { name: "Greendale", city: "Harare", lat: -17.817, lng: 31.121 },
  { name: "Msasa", city: "Harare", lat: -17.842, lng: 31.115 },
  { name: "Arcadia", city: "Harare", lat: -17.841, lng: 31.061 },
  { name: "Braeside", city: "Harare", lat: -17.852, lng: 31.073 },
  { name: "Hatfield", city: "Harare", lat: -17.875, lng: 31.09 },
  { name: "Waterfalls", city: "Harare", lat: -17.89, lng: 31.03 },
  { name: "Southerton", city: "Harare", lat: -17.866, lng: 31.015 },
  { name: "Workington", city: "Harare", lat: -17.848, lng: 31.022 },
  { name: "Mbare", city: "Harare", lat: -17.858, lng: 31.035, aliases: ["mbare musika", "siyaso"] },
  { name: "Highfield", city: "Harare", lat: -17.875, lng: 30.999, aliases: ["machipisa"] },
  { name: "Glen View", city: "Harare", lat: -17.897, lng: 30.957, aliases: ["glenview", "glen view complex"] },
  { name: "Budiriro", city: "Harare", lat: -17.897, lng: 30.928 },
  { name: "Glen Norah", city: "Harare", lat: -17.908, lng: 30.975, aliases: ["glen norah"] },
  { name: "Mufakose", city: "Harare", lat: -17.868, lng: 30.934 },
  { name: "Kuwadzana", city: "Harare", lat: -17.833, lng: 30.923 },
  { name: "Warren Park", city: "Harare", lat: -17.833, lng: 30.969 },
  { name: "Kambuzuma", city: "Harare", lat: -17.852, lng: 30.953 },
  { name: "Dzivarasekwa", city: "Harare", lat: -17.818, lng: 30.912, aliases: ["dzivarasekwa extension"] },
  { name: "Mabelreign", city: "Harare", lat: -17.788, lng: 30.996 },
  { name: "Marlborough", city: "Harare", lat: -17.745, lng: 31.009 },
  { name: "Westgate", city: "Harare", lat: -17.778, lng: 30.988 },
  { name: "Bluff Hill", city: "Harare", lat: -17.771, lng: 30.999 },
  { name: "Emerald Hill", city: "Harare", lat: -17.784, lng: 31.019 },
  { name: "Tafara", city: "Harare", lat: -17.815, lng: 31.158 },
  { name: "Mabvuku", city: "Harare", lat: -17.814, lng: 31.168 },
  { name: "Epworth", city: "Harare", lat: -17.89, lng: 31.147 },
  { name: "Chitungwiza", city: "Harare", lat: -18.0, lng: 31.075, aliases: ["chitown", "chi-town", "zengeza", "seke", "st marys"] },
  { name: "Ruwa", city: "Harare", lat: -17.89, lng: 31.245 },
  { name: "Norton", city: "Harare", lat: -17.883, lng: 30.7 },
  // Bulawayo
  { name: "Bulawayo", city: "Bulawayo", lat: -20.15, lng: 28.5833, aliases: ["byo"] },
  { name: "Bulawayo CBD", city: "Bulawayo", lat: -20.15, lng: 28.5833, aliases: ["byo town", "bulawayo town", "byo cbd"] },
  { name: "Suburbs", city: "Bulawayo", lat: -20.145, lng: 28.6 },
  { name: "Hillside", city: "Bulawayo", lat: -20.18, lng: 28.6 },
  { name: "Burnside", city: "Bulawayo", lat: -20.195, lng: 28.615 },
  { name: "Famona", city: "Bulawayo", lat: -20.17, lng: 28.595 },
  { name: "Nkulumane", city: "Bulawayo", lat: -20.205, lng: 28.525 },
  { name: "Entumbane", city: "Bulawayo", lat: -20.135, lng: 28.525 },
  { name: "Pumula", city: "Bulawayo", lat: -20.14, lng: 28.49 },
  { name: "Magwegwe", city: "Bulawayo", lat: -20.145, lng: 28.51 },
  { name: "Cowdray Park", city: "Bulawayo", lat: -20.115, lng: 28.51 },
  { name: "Luveve", city: "Bulawayo", lat: -20.125, lng: 28.535 },
  { name: "Mpopoma", city: "Bulawayo", lat: -20.15, lng: 28.535 },
  // Other towns
  { name: "Mutare", city: "Mutare", lat: -18.9707, lng: 32.6709 },
  { name: "Gweru", city: "Gweru", lat: -19.45, lng: 29.8167 },
  { name: "Kwekwe", city: "Kwekwe", lat: -18.9167, lng: 29.8167 },
  { name: "Masvingo", city: "Masvingo", lat: -20.0744, lng: 30.8328 },
  { name: "Chinhoyi", city: "Chinhoyi", lat: -17.3667, lng: 30.2 },
  { name: "Marondera", city: "Marondera", lat: -18.1853, lng: 31.5519 },
  { name: "Kadoma", city: "Kadoma", lat: -18.3333, lng: 29.9167 },
  { name: "Victoria Falls", city: "Victoria Falls", lat: -17.9243, lng: 25.8572, aliases: ["vic falls"] },
];
