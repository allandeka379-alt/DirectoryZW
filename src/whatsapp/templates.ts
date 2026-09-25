import type { Config } from "../config.js";

type TemplateKey = Exclude<keyof Config["whatsapp"]["templates"], "language">;

/**
 * The approved message templates the app sends once the 24-hour window has closed. The body
 * variables and quick-reply buttons must match what the code sends (see where each is used).
 */
export interface TemplateDefinition {
  key: TemplateKey;
  body: string;
  /** Sample values for {{1}}, {{2}}…, which Meta needs to review the template. */
  example: string[];
  quickReplies: string[];
  usedFor: string;
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    key: "leadNotification",
    body: "New customer (ref {{1}}) is looking for: {{2}}. They'll message you on WhatsApp shortly.",
    example: ["K7Q2M", "a plumber for a burst geyser in Mabelreign"],
    quickReplies: [],
    usedFor: "Telling a business a customer is about to message them",
  },
  {
    key: "followUp",
    body: "Did you get what you needed from {{1}}?",
    example: ["QuickFix Plumbing"],
    quickReplies: ["Yes, sorted", "Not yet", "It didn't work out"],
    usedFor: "Asking a customer how it went, a few days after connecting",
  },
  {
    key: "weeklySummary",
    body: "Your week: {{1}} was shown in {{2}} searches and {{3}} customers connected with you.",
    example: ["QuickFix Plumbing", "14", "3"],
    quickReplies: [],
    usedFor: "Monday summary for businesses with activity",
  },
];

/** The request body for creating a template with the WhatsApp Business Management API. */
export function templatePayload(def: TemplateDefinition, name: string, language: string): Record<string, unknown> {
  const components: Record<string, unknown>[] = [{ type: "BODY", text: def.body, example: { body_text: [def.example] } }];
  if (def.quickReplies.length) {
    components.push({ type: "BUTTONS", buttons: def.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) });
  }
  return { name, language, category: "UTILITY", components };
}

/** Number of {{n}} variables in a template body. */
export function variableCount(body: string): number {
  return new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
}
