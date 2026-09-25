/** One labelled request: what a customer wrote and what the app should understand from it. */
export interface EvalExample {
  id: string;
  text: string;
  language: string;
  expect: {
    intent: string;
    /** Category slug; null means "no category". Leave out to skip scoring the category. */
    category?: string | null;
    /** Area name as in the gazetteer. Leave out to skip scoring the area. */
    area?: string;
  };
  source: "synthetic" | "real";
  /** Exported real requests start unreviewed: their labels are only what the app decided at the time. */
  reviewed?: boolean;
}

export interface Answer {
  intent: string;
  category: string | null;
  area: string | null;
}

export interface Outcome {
  example: EvalExample;
  got: Answer | null;
  error?: string;
  ms: number;
  intent: boolean;
  /** null when the example doesn't score this field. */
  category: boolean | null;
  area: boolean | null;
}

export interface Score {
  n: number;
  errors: number;
  intent: number;
  category: number | null;
  area: number | null;
  avgMs: number;
}

export function parseExamples(jsonl: string): EvalExample[] {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .map((line, i) => {
      const e = JSON.parse(line) as EvalExample;
      if (!e.id || !e.text || !e.expect?.intent) throw new Error(`Line ${i + 1} needs id, text and expect.intent`);
      return e;
    });
}

export function judge(example: EvalExample, got: Answer | null, ms: number, error?: string): Outcome {
  const e = example.expect;
  return {
    example,
    got,
    error,
    ms,
    intent: got?.intent === e.intent,
    category: e.category === undefined ? null : got?.category === e.category,
    area: e.area === undefined ? null : got?.area === e.area,
  };
}

export function score(outcomes: Outcome[]): Score {
  const share = (values: (boolean | null)[]) => {
    const scored = values.filter((v): v is boolean => v !== null);
    return scored.length ? scored.filter(Boolean).length / scored.length : null;
  };
  return {
    n: outcomes.length,
    errors: outcomes.filter((o) => o.error).length,
    intent: share(outcomes.map((o) => o.intent)) ?? 0,
    category: share(outcomes.map((o) => o.category)),
    area: share(outcomes.map((o) => o.area)),
    avgMs: outcomes.length ? outcomes.reduce((t, o) => t + o.ms, 0) / outcomes.length : 0,
  };
}

export function scoreByLanguage(outcomes: Outcome[]): Record<string, Score> {
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) groups.set(o.example.language, [...(groups.get(o.example.language) ?? []), o]);
  return Object.fromEntries([...groups.entries()].sort().map(([lang, list]) => [lang, score(list)]));
}
