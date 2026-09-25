/** Lowercase, drop punctuation and collapse spaces: "Samsung 55\" TV!!" -> "samsung 55 tv". */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `phrase` appears in `text` as whole words (both already normalized), allowing a plural. */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const t = ` ${text} `;
  return t.includes(` ${phrase} `) || t.includes(` ${phrase}s `) || t.includes(` ${phrase}es `);
}

const STOPWORDS = new Set(
  (
    "a an the i im me my we our you your u to for of in on at by with and or but is are was be am do does did " +
    "need needs want wants wanted looking look find finding get getting buy buying please pls plz someone somebody who " +
    "can could would will where which what any some sell sells selling seller have has near nearby around about " +
    "cheap cheapest best good nice new under below less than max maximum budget price prices cost usd dollars " +
    "today tomorrow now urgently urgent asap this next week weekend saturday sunday monday tuesday wednesday thursday friday " +
    "hi hello hey there thanks thank " +
    "kindly assist anyone anybody know knows should must may might also too their it its them they he she his her us " +
    "from into out up same other another more much many how when why that these those if so then as not no yes ok okay " +
    "were been had done doing going come go let tell place places somewhere area location side suburb number contact " +
    "contacts details info person guy company companies business businesses service services shop store good reliable " +
    "trusted affordable professional quick fast quickly available here just only very really all every one something " +
    "sir madam maam boss bro sis guys team admin morning afternoon evening hie hy " +
    // Shona and Ndebele words people mix into requests ("ndoda plumber ku Mabelreign")
    "ndoda ndinoda ndirikuda ndiri ndinotsvaga ndirikutsvaga ndichada ndapota ndibatsirei ndibatsire ndiudzei " +
    "ku kwa mu pa ne na uye here kupi ndekupi ari ane anogona munhu mumwe akanaka wakanaka iripi riripi mhoro mhoroi " +
    "ngifuna ngiyafuna ngidinga ngicela ngiyacela kuphi lapho umuntu omunye sawubona salibonani"
  ).split(" "),
);

/** Words that carry no meaning of their own in a request: "please", "near", "ndoda" (I want). */
export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}

/** Texting spellings, so "pls fix my fone 2moro" reads like the words the engine knows. */
const TEXTING: Record<string, string> = {
  pls: "please", plz: "please", plse: "please", plis: "please", tmrw: "tomorrow", tmr: "tomorrow", tmoro: "tomorrow",
  "2moro": "tomorrow", "2mrw": "tomorrow", "2morrow": "tomorrow", tomoro: "tomorrow", tommorow: "tomorrow", tomorow: "tomorrow",
  "2day": "today", tdy: "today", thx: "thanks", thnx: "thanks", tnx: "thanks", thanx: "thanks", u: "you", ur: "your",
  wat: "what", wht: "what", hw: "how", whr: "where", ppl: "people", pple: "people", gud: "good", nid: "need", nyd: "need",
  wnt: "want", wana: "want", wanna: "want", lukin: "looking", lookin: "looking", frm: "from", wid: "with", smone: "someone",
  sm1: "someone", some1: "someone", any1: "anyone", cn: "can", dnt: "dont", abt: "about", bt: "but", fone: "phone",
};

/**
 * normalizeText, plus what people do when texting: common short spellings ("pls", "2moro"),
 * numbers stuck to units ("55inch" → "55 inch", "5kva") and stretched letters ("pleeease" → "pleease";
 * the engine tries the word with single letters too).
 */
export function normalizeMessage(text: string): string {
  return normalizeText(text)
    .split(" ")
    .map((w) => TEXTING[w] ?? w.replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])\1{2,}/g, "$1$1"))
    .join(" ")
    .trim();
}

/** Content words worth searching for, in order, without duplicates. */
export function searchTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of normalizeText(text).split(" ")) {
    if (!w || STOPWORDS.has(w) || seen.has(w)) continue;
    if (w.length < 2 && !/^\d+$/.test(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, 8);
}

/** Pull a US-dollar budget out of text: "under $600", "600 usd", "budget 1,200". */
export function parseBudget(text: string): number | null {
  const t = text.toLowerCase().replace(/,/g, "");
  const patterns = [
    /(?:under|below|less than|max(?:imum)?|budget(?: of| is)?|up to|not more than)\s*(?:us)?\$?\s*(\d+(?:\.\d+)?)/,
    /\$\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(?:usd|us\$|dollars)/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/** Zimbabwean mobile numbers in local or international form -> "2637XXXXXXXX", else null. */
export function normalizeZimPhone(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (/^2637\d{8}$/.test(d)) return d;
  if (/^07\d{8}$/.test(d)) return `263${d.slice(1)}`;
  if (/^7\d{8}$/.test(d)) return `263${d}`;
  if (/^\d{10,15}$/.test(d) && !d.startsWith("0")) return d; // other international numbers
  return null;
}
