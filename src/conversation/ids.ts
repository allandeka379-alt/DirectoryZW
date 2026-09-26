/** IDs carried by WhatsApp buttons and list rows (max 256 characters), as "action:arg:arg". */
export const Ids = {
  // Customer number
  consent: "consent:yes",
  business: (requestId: string, businessId: string) => `biz:${requestId}:${businessId}`,
  connect: (requestId: string, businessId: string) => `con:${requestId}:${businessId}`,
  list: (requestId: string) => `list:${requestId}`,
  human: (requestId = "") => `human:${requestId}`,
  newSearch: "new",
  report: (businessId: string) => `rep:${businessId}`,
  /**
   * The follow-up: "failed" (It didn't work out) asks what happened; "other" (Something else)
   * asks them to tell us, as a report.
   */
  feedback: (introId: string, outcome: "sorted" | "not_yet" | "failed" | "no_reply" | "couldnt_help" | "other") =>
    `fb:${introId}:${outcome}`,
  rate: (introId: string, stars: number) => `rate:${introId}:${stars}`,
  eraseYes: "erase:yes",
  eraseNo: "erase:no",
  /** "Not what I asked for" under results. */
  notIt: (requestId: string) => `notit:${requestId}`,
  /** An answer to "Did you mean…?": a category, or none of them. */
  mean: (slug: string) => `mean:${slug}`,
  meanOther: "mean:",
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
  myCustomers: "bleads",
  /** Looking for supplies for the owner's own business. */
  findSupplier: "bbuy",
  sellsTo: "btrade",
  setTrade: (trade: "retail" | "wholesale" | "both") => `btrade:${trade}`,
  pause: "bpause",
  resume: "bresume",
  remove: "bremove",
  removeConfirm: "bremove:yes",
  switchBusiness: "bswitch",
  selectBusiness: (businessId: string) => `bsel:${businessId}`,
  editWhat: "bedit:what",
  editArea: "bedit:area",
  editSave: "bedit:save",
  // Choosing a category by hand: a page of kinds of business, one kind's categories, one category.
  pickGroupsPage: (page: number) => `bpick:g:${page}`,
  pickGroup: (groupIndex: number) => `bpick:c:${groupIndex}:0`,
  pickCategoriesPage: (groupIndex: number, page: number) => `bpick:c:${groupIndex}:${page}`,
  pickCategory: (slug: string) => `bpick:s:${slug}`,
} as const;

export function parseAction(id: string): { action: string; args: string[] } {
  const [action = "", ...args] = id.split(":");
  return { action, args };
}
