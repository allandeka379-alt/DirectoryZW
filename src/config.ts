import { z } from "zod";

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["true", "1", "yes"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  BRAND_NAME: z.string().default("Directory ZW"),
  PRIVACY_URL: optionalString,
  BUSINESS_TERMS_URL: optionalString,
  DATABASE_URL: optionalString,
  PGLITE_DIR: z.string().default("./.data/pglite"),
  SEED_SAMPLE_DATA: flag(false),
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  WHATSAPP_TRANSPORT: z.enum(["simulator", "cloud"]).default("simulator"),
  WHATSAPP_GRAPH_VERSION: z.string().default("v24.0"),
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_CUSTOMER_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_BUSINESS_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_CUSTOMER_NUMBER: z.string().default("263770000000"),
  WHATSAPP_BUSINESS_NUMBER: z.string().default("263770000001"),
  TEMPLATE_LANGUAGE: z.string().default("en"),
  TEMPLATE_LEAD_NOTIFICATION: z.string().default("lead_notification"),
  TEMPLATE_FOLLOW_UP: z.string().default("follow_up"),
  TEMPLATE_ASK_AROUND: z.string().default("ask_around"),
  TEMPLATE_ASK_AROUND_REPLY: z.string().default("ask_around_reply"),
  OPS_TOKEN: optionalString,
  FOLLOW_UP_DELAY_HOURS: z.coerce.number().positive().default(72),
  MIN_VERIFIED_RESULTS: z.coerce.number().int().min(0).default(3),
  MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(8),
  JOB_POLL_SECONDS: z.coerce.number().positive().default(15),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host: string;
  brandName: string;
  privacyUrl?: string;
  businessTermsUrl?: string;
  databaseUrl?: string;
  pgliteDir: string;
  seedSampleData: boolean;
  anthropicApiKey?: string;
  claudeModel: string;
  whatsapp: {
    transport: "simulator" | "cloud";
    graphVersion: string;
    accessToken?: string;
    appSecret?: string;
    verifyToken?: string;
    phoneNumberIds: { customer: string; business: string };
    numbers: { customer: string; business: string };
    templates: {
      language: string;
      leadNotification: string;
      followUp: string;
      askAround: string;
      askAroundReply: string;
    };
  };
  opsToken?: string;
  followUpDelayHours: number;
  minVerifiedResults: number;
  maxResults: number;
  jobPollSeconds: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const config: Config = {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    brandName: e.BRAND_NAME,
    privacyUrl: e.PRIVACY_URL,
    businessTermsUrl: e.BUSINESS_TERMS_URL,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    seedSampleData: e.SEED_SAMPLE_DATA,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeModel: e.CLAUDE_MODEL,
    whatsapp: {
      transport: e.WHATSAPP_TRANSPORT,
      graphVersion: e.WHATSAPP_GRAPH_VERSION,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      phoneNumberIds: {
        customer: e.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID ?? "sim-customer",
        business: e.WHATSAPP_BUSINESS_PHONE_NUMBER_ID ?? "sim-business",
      },
      numbers: { customer: digits(e.WHATSAPP_CUSTOMER_NUMBER), business: digits(e.WHATSAPP_BUSINESS_NUMBER) },
      templates: {
        language: e.TEMPLATE_LANGUAGE,
        leadNotification: e.TEMPLATE_LEAD_NOTIFICATION,
        followUp: e.TEMPLATE_FOLLOW_UP,
        askAround: e.TEMPLATE_ASK_AROUND,
        askAroundReply: e.TEMPLATE_ASK_AROUND_REPLY,
      },
    },
    opsToken: e.OPS_TOKEN,
    followUpDelayHours: e.FOLLOW_UP_DELAY_HOURS,
    minVerifiedResults: e.MIN_VERIFIED_RESULTS,
    maxResults: e.MAX_RESULTS,
    jobPollSeconds: e.JOB_POLL_SECONDS,
  };
  validate(config);
  return config;
}

function validate(c: Config): void {
  const problems: string[] = [];
  if (c.whatsapp.transport === "cloud") {
    if (!c.whatsapp.accessToken) problems.push("WHATSAPP_ACCESS_TOKEN is required for the cloud transport");
    if (!c.whatsapp.appSecret) problems.push("WHATSAPP_APP_SECRET is required for the cloud transport");
    if (!c.whatsapp.verifyToken) problems.push("WHATSAPP_VERIFY_TOKEN is required for the cloud transport");
    if (c.whatsapp.phoneNumberIds.customer.startsWith("sim-") || c.whatsapp.phoneNumberIds.business.startsWith("sim-")) {
      problems.push("Both WhatsApp phone number IDs are required for the cloud transport");
    }
  }
  if (c.env === "production") {
    if (!c.opsToken) problems.push("OPS_TOKEN is required in production");
    if (c.seedSampleData) problems.push("SEED_SAMPLE_DATA must be off in production");
    if (c.whatsapp.transport !== "cloud") problems.push("Production must use the cloud WhatsApp transport");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
}

/** Keep only digits: "+263 77 123 4567" -> "263771234567". */
export function digits(value: string): string {
  return value.replace(/\D/g, "");
}
