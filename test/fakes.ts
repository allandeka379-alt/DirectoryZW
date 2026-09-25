import type { FoundBusiness, OnlineFinder, OnlineSearch } from "../src/ai/online-finder.js";
import type { InterpretContext, RequestInterpretation } from "../src/ai/types.js";
import type { PriceList, Vision } from "../src/ai/vision.js";
import type { Media } from "../src/whatsapp/media.js";

export function interpretation(fields: Partial<RequestInterpretation>): RequestInterpretation {
  return {
    intent: "search",
    category_slug: null,
    query: "",
    area: null,
    budget_usd: null,
    needed_by: null,
    clarifying_question: null,
    language: "en",
    ...fields,
  };
}

/** Stands in for Claude vision: answers come from the test. */
export class FakeVision implements Vision {
  readonly photos: { caption?: string; image: Media }[] = [];
  readonly priceLists: Media[] = [];
  photoAnswer: (caption: string | undefined) => RequestInterpretation | null = () => null;
  priceListAnswer: PriceList | null = null;

  async interpretPhoto(image: Media, caption: string | undefined, _ctx: InterpretContext): Promise<RequestInterpretation | null> {
    this.photos.push({ caption, image });
    return this.photoAnswer(caption);
  }

  async readPriceList(image: Media): Promise<PriceList | null> {
    this.priceLists.push(image);
    return this.priceListAnswer;
  }
}

/** Stands in for the web search: returns whatever the test says for a query. */
export class FakeFinder implements OnlineFinder {
  readonly calls: OnlineSearch[] = [];
  answer: (q: OnlineSearch) => FoundBusiness[] = () => [];

  async find(q: OnlineSearch): Promise<FoundBusiness[]> {
    this.calls.push(q);
    return this.answer(q);
  }
}

export function found(name: string, phone: string, fields: Partial<FoundBusiness> = {}): FoundBusiness {
  return {
    name,
    phone,
    description: `${name} description`,
    area: null,
    sourceUrl: `https://www.facebook.com/${name.replace(/\W+/g, "").toLowerCase()}`,
    sourceTitle: `${name} | Facebook`,
    ...fields,
  };
}
