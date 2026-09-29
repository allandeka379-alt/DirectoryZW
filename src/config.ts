import { z } from "zod";
import { parseUnknownWords, type LocalSettings } from "./ai/local.js";
import { parseTeamHours, type TeamHours } from "./time.js";

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
  BRAND_NAME: z.string().default("FindZim"),
  PRIVACY_URL: optionalString,
  BUSINESS_TERMS_URL: optionalString,
  DATABASE_URL: optionalString,
  PGLITE_DIR: z.string().default("./.data/pglite"),
  UPLOADS_DIR: z.string().default("./.data/uploads"),
  PUBLIC_BASE_URL: optionalString,
  SEED_SAMPLE_DATA: flag(false),
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  CLAUDE_DAILY_BUDGET_USD: z.coerce.number().min(0).default(1),
  CLAUDE_CALLS_PER_NUMBER_PER_DAY: z.coerce.number().int().min(0).default(3),
  CLAUDE_TIMEOUT_SECONDS: z.coerce.number().positive().max(120).default(6),
  LEXICON_TRUST_DRAFTS: flag(false),
  TEAM_HOURS: z.string().default("Mon-Sat 08:00-18:00"),
  LOCAL_UNKNOWN_WORDS: z.string().default("en:1,sn:0,nd:0"),
  LOCAL_CLASSIFIER_MIN: z.coerce.number().min(0).max(1).default(0.4),
  STORAGE: z.enum(["disk", "s3"]).default("disk"),
  S3_BUCKET: optionalString,
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_PREFIX: z.string().default(""),
  S3_FORCE_PATH_STYLE: flag(false),
  ALERT_WEBHOOK_URL: optionalString,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).default(300),
  REPORTS_PER_DAY: z.coerce.number().int().min(1).default(3),
  REPORTS_TO_PAUSE: z.coerce.number().int().min(0).default(3),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(30).default(180),
  REQUEST_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),
  OPS_SESSION_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  WHATSAPP_TRANSPORT: z.enum(["simulator", "cloud", "off"]).default("simulator"),
  WHATSAPP_GRAPH_VERSION: z.string().default("v24.0"),
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  /** Our one WhatsApp number: customers and businesses both message it. */
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_NUMBER: z.string().default("263770000000"),
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalString,
  TEMPLATE_LANGUAGE: z.string().default("en"),
  TEMPLATE_LEAD_NOTIFICATION: z.string().default("lead_notification"),
  TEMPLATE_FOLLOW_UP: z.string().default("follow_up"),
  TEMPLATE_WEEKLY_SUMMARY: z.string().default("weekly_summary"),
  OPS_TOKEN: optionalString,
  FOLLOW_UP_DELAY_HOURS: z.coerce.number().positive().default(20),
  PAID_FOLLOW_UPS: flag(false),
  LEAD_NOTICES: z.enum(["free_only", "always"]).default("free_only"),
  WEEKLY_SUMMARIES: z.enum(["off", "window_only", "always"]).default("off"),
  WHATSAPP_TEMPLATE_PRICE_USD: z.coerce.number().min(0).default(0.004),
  TEMPLATE_DAILY_CAP: z.coerce.number().int().min(0).default(100),
  MIN_VERIFIED_RESULTS: z.coerce.number().int().min(0).default(3),
  MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(8),
  JOB_POLL_SECONDS: z.coerce.number().positive().default(15),
  // Products on WhatsApp: an alert when a store lists what a customer couldn't find, and product
  // cards from our Meta catalog (the simulator has its own catalog).
  PRODUCT_ALERTS: z.enum(["on", "off"]).default("on"),
  PRODUCT_ALERT_HOURS: z.coerce.number().positive().max(24).default(24),
  PRODUCT_CARDS: z.enum(["on", "off"]).default("on"),
  WHATSAPP_CATALOG_ID: optionalString,
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
  /** Where field photos are stored (local disk for now). */
  uploadsDir: string;
  /** Public address of this server, used in field-agent setup links. */
  publicBaseUrl: string;
  seedSampleData: boolean;
  anthropicApiKey?: string;
  /** Used only when the local engine can't understand a request. */
  claudeModel: string;
  /** Claude spending stops for the day at `dailyUsd`; one number can cause `perNumberPerDay` calls. */
  claudeBudget: { dailyUsd: number; perNumberPerDay: number };
  /** A Claude call that takes longer gives up (one retry), so no customer waits on it. */
  claudeTimeoutMs: number;
  /** Use draft lexicon words (the unreviewed Shona and Ndebele lists) as if a native speaker had approved them. */
  lexiconTrustDrafts: boolean;
  /** When a person answers chats handed to the team, so customers are told when to expect a reply. */
  teamHours: TeamHours;
  /** The local engine's thresholds: unknown words allowed in a straight answer, and the classifier's bar. */
  local: LocalSettings;
  /** Where business photos are kept. */
  storage:
    | { driver: "disk" }
    | {
        driver: "s3";
        bucket: string;
        region: string;
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        prefix: string;
        forcePathStyle: boolean;
      };
  /** Slack, Discord or Google Chat incoming webhook for alerts. Alerts are only logged without it. */
  alertWebhookUrl?: string;
  /** Per-number limits against floods and abuse. */
  limits: { perMinute: number; perDay: number; reportsPerDay: number; reportsToPause: number };
  /** How long conversation data is kept. */
  retention: { messageDays: number; requestDays: number };
  opsSessionHours: number;
  whatsapp: {
    /** "off" before launch: the website and admin portal run, and nothing is sent on WhatsApp. */
    transport: "simulator" | "cloud" | "off";
    graphVersion: string;
    accessToken?: string;
    appSecret?: string;
    verifyToken?: string;
    /** Meta's ID for our WhatsApp number ("sim-whatsapp" in the simulator). */
    phoneNumberId: string;
    /** The number itself, digits only. */
    number: string;
    /** WhatsApp Business Account ID, for managing message templates. */
    businessAccountId?: string;
    /** Our Meta catalog, connected to the number: products with a photo and a price go in it. */
    catalogId?: string;
    templates: {
      language: string;
      leadNotification: string;
      followUp: string;
      weeklySummary: string;
    };
  };
  opsToken?: string;
  /**
   * Hours after "Connect me" before the follow-up. Inside the 24-hour window the tap opens, it's
   * free; later, it needs a paid template, sent only with `paidFollowUps`.
   */
  followUpDelayHours: number;
  paidFollowUps: boolean;
  /** "free_only": tell a business about a lead only while its own 24-hour window is open (free). */
  leadNotices: "free_only" | "always";
  /** Monday summaries to businesses: "off" (they see their week in the menu), "window_only" (free) or "always". */
  weeklySummaries: "off" | "window_only" | "always";
  /** What one template message costs (Rest of Africa utility rate), for the running-costs figures. */
  templatePriceUsd: number;
  /** Templates we send in a day at most; past it they stop and the team is alerted. 0 means none at all. */
  templateDailyCap: number;
  minVerifiedResults: number;
  maxResults: number;
  jobPollSeconds: number;
  products: {
    /** Tell a customer once when a store lists what they asked for and nobody had. Free: inside their window only. */
    alerts: boolean;
    /** How far back a request can be for an alert (at most the 24-hour window). */
    alertHours: number;
    /** Send WhatsApp product cards from the catalog with results. Needs a catalog (the simulator has one). */
    cards: boolean;
  };
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
    uploadsDir: e.UPLOADS_DIR,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ""),
    seedSampleData: e.SEED_SAMPLE_DATA,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeModel: e.CLAUDE_MODEL,
    claudeBudget: { dailyUsd: e.CLAUDE_DAILY_BUDGET_USD, perNumberPerDay: e.CLAUDE_CALLS_PER_NUMBER_PER_DAY },
    claudeTimeoutMs: Math.round(e.CLAUDE_TIMEOUT_SECONDS * 1000),
    lexiconTrustDrafts: e.LEXICON_TRUST_DRAFTS,
    teamHours: parseTeamHours(e.TEAM_HOURS),
    local: { unknownWords: parseUnknownWords(e.LOCAL_UNKNOWN_WORDS), classifierMin: e.LOCAL_CLASSIFIER_MIN },
    storage:
      e.STORAGE === "s3"
        ? {
            driver: "s3",
            bucket: e.S3_BUCKET ?? "",
            region: e.S3_REGION,
            endpoint: e.S3_ENDPOINT,
            accessKeyId: e.S3_ACCESS_KEY_ID,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY,
            prefix: e.S3_PREFIX.replace(/^\/+|\/+$/g, ""),
            forcePathStyle: e.S3_FORCE_PATH_STYLE,
          }
        : { driver: "disk" },
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    limits: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      perDay: e.RATE_LIMIT_PER_DAY,
      reportsPerDay: e.REPORTS_PER_DAY,
      reportsToPause: e.REPORTS_TO_PAUSE,
    },
    retention: { messageDays: e.MESSAGE_RETENTION_DAYS, requestDays: e.REQUEST_RETENTION_DAYS },
    opsSessionHours: e.OPS_SESSION_HOURS,
    whatsapp: {
      transport: e.WHATSAPP_TRANSPORT,
      graphVersion: e.WHATSAPP_GRAPH_VERSION,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID ?? "sim-whatsapp",
      number: digits(e.WHATSAPP_NUMBER),
      businessAccountId: e.WHATSAPP_BUSINESS_ACCOUNT_ID,
      catalogId: e.WHATSAPP_CATALOG_ID ?? (e.WHATSAPP_TRANSPORT === "simulator" ? "sim-catalog" : undefined),
      templates: {
        language: e.TEMPLATE_LANGUAGE,
        leadNotification: e.TEMPLATE_LEAD_NOTIFICATION,
        followUp: e.TEMPLATE_FOLLOW_UP,
        weeklySummary: e.TEMPLATE_WEEKLY_SUMMARY,
      },
    },
    opsToken: e.OPS_TOKEN,
    followUpDelayHours: e.FOLLOW_UP_DELAY_HOURS,
    paidFollowUps: e.PAID_FOLLOW_UPS,
    leadNotices: e.LEAD_NOTICES,
    weeklySummaries: e.WEEKLY_SUMMARIES,
    templatePriceUsd: e.WHATSAPP_TEMPLATE_PRICE_USD,
    templateDailyCap: e.TEMPLATE_DAILY_CAP,
    minVerifiedResults: e.MIN_VERIFIED_RESULTS,
    maxResults: e.MAX_RESULTS,
    jobPollSeconds: e.JOB_POLL_SECONDS,
    products: { alerts: e.PRODUCT_ALERTS === "on", alertHours: e.PRODUCT_ALERT_HOURS, cards: e.PRODUCT_CARDS === "on" },
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
    if (c.whatsapp.phoneNumberId.startsWith("sim-")) problems.push("WHATSAPP_PHONE_NUMBER_ID is required for the cloud transport");
  }
  if (c.storage.driver === "s3" && !c.storage.bucket) problems.push("S3_BUCKET is required when STORAGE=s3");
  if (c.env === "production") {
    if (!c.opsToken) problems.push("OPS_TOKEN is required in production");
    if (!c.databaseUrl) problems.push("DATABASE_URL is required in production (embedded PGlite is for development)");
    if (c.seedSampleData) problems.push("SEED_SAMPLE_DATA must be off in production");
    if (c.whatsapp.transport === "simulator") problems.push("Production must use the cloud WhatsApp transport (or off, before launch)");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
}

/** "a, b,c" -> ["a", "b", "c"]. */
function list(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Keep only digits: "+263 77 123 4567" -> "263771234567". */
export function digits(value: string): string {
  return value.replace(/\D/g, "");
}
