/** IDs carried by WhatsApp buttons and list rows (max 256 characters), as "action:arg:arg". */
export const Ids = {
  // Customer number
  consent: "consent:yes",
  business: (requestId: string, businessId: string) => `biz:${requestId}:${businessId}`,
  connect: (requestId: string, businessId: string) => `con:${requestId}:${businessId}`,
  list: (requestId: string) => `list:${requestId}`,
  askAround: (requestId: string) => `ask:${requestId}`,
  human: (requestId = "") => `human:${requestId}`,
  newSearch: "new",
  report: (businessId: string) => `rep:${businessId}`,
  feedback: (introId: string, outcome: "sorted" | "not_yet" | "no_reply") => `fb:${introId}:${outcome}`,
  rate: (introId: string, stars: number) => `rate:${introId}:${stars}`,
  onlineBusiness: (requestId: string, leadId: string) => `obiz:${requestId}:${leadId}`,
  onlineConnect: (requestId: string, leadId: string) => `ocon:${requestId}:${leadId}`,
  // Business number
  register: "breg:start",
  categoriesOk: "breg:catok",
  categoriesChange: "breg:catchange",
  phoneThis: "breg:phonethis",
  phoneOther: "breg:phoneother",
  agree: "breg:agree",
  howItWorks: "bhow",
  menu: "bmenu",
  summary: "bsum",
  pause: "bpause",
  resume: "bresume",
  remove: "bremove",
  removeConfirm: "bremove:yes",
  askAroundYes: (askId: string) => `aa:${askId}:yes`,
  askAroundNo: (askId: string) => `aa:${askId}:no`,
  switchBusiness: "bswitch",
  selectBusiness: (businessId: string) => `bsel:${businessId}`,
  editWhat: "bedit:what",
  editArea: "bedit:area",
  editSave: "bedit:save",
  priceList: "bprice:start",
  priceSave: "bprice:save",
  priceRetry: "bprice:retry",
} as const;

export function parseAction(id: string): { action: string; args: string[] } {
  const [action = "", ...args] = id.split(":");
  return { action, args };
}
