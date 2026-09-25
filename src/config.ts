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
  BRAND_NAME: z.string().default("Directory ZW"),
  PRIVACY_URL: optionalString,
  BUSINESS_TERMS_URL: optionalString,
  DATABASE_URL: optionalString,
  PGLITE_DIR: z.string().default("./.data/pglite"),
  UPLOADS_DIR: z.string().default("./.data/uploads"),
  PUBLIC_BASE_URL: optionalString,
  SEED_SAMPLE_DATA: flag(false),
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  CLAUDE_DAILY_BUDGET_USD: z.coerce.number().min(0).default(5),
  CLAUDE_CALLS_PER_NUMBER_PER_DAY: z.coerce.number().int().min(0).default(5),
  LEXICON_TRUST_DRAFTS: flag(false),
  TEAM_HOURS: z.string().default("Mon-Sat 08:00-18:00"),
  PRICE_LIST_BATCH: flag(true),
  LOCAL_UNKNOWN_WORDS: z.string().default("en:1,sn:0,nd:0"),
  LOCAL_CLASSIFIER_MIN: z.coerce.number().min(0).max(1).default(0.4),
  SPEECH_TO_TEXT_URL: optionalString,
  SPEECH_TO_TEXT_TOKEN: optionalString,
  SPEECH_LANGUAGES: z.string().default("sn,nd,en"),
  MAX_MEDIA_MB: z.coerce.number().positive().max(100).default(16),
  GOOGLE_STT_PROJECT: optionalString,
  GOOGLE_STT_LOCATION: z.string().default("europe-west4"),
  GOOGLE_STT_LANGUAGES: z.string().default("sn-ZW,zu-ZA,en-US"),
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
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
  MEDIA_PER_DAY: z.coerce.number().int().min(0).default(20),
  REPORTS_PER_DAY: z.coerce.number().int().min(1).default(3),
  REPORTS_TO_PAUSE: z.coerce.number().int().min(0).default(3),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(30).default(180),
  REQUEST_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),
  OPS_SESSION_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  WHATSAPP_TRANSPORT: z.enum(["simulator", "cloud"]).default("simulator"),
  WHATSAPP_GRAPH_VERSION: z.string().default("v24.0"),
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_CUSTOMER_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_BUSINESS_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_CUSTOMER_NUMBER: z.string().default("263770000000"),
  WHATSAPP_BUSINESS_NUMBER: z.string().default("263770000001"),
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalString,
  TEMPLATE_LANGUAGE: z.string().default("en"),
  TEMPLATE_LEAD_NOTIFICATION: z.string().default("lead_notification"),
  TEMPLATE_FOLLOW_UP: z.string().default("follow_up"),
  TEMPLATE_WEEKLY_SUMMARY: z.string().default("weekly_summary"),
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
  /** Where field photos are stored (local disk for now). */
  uploadsDir: string;
  /** Public address of this server, used in field-agent setup links. */
  publicBaseUrl: string;
  seedSampleData: boolean;
  anthropicApiKey?: string;
  /** Used only when the local engine can't understand a request, and for photos. */
  claudeModel: string;
  /** Claude spending stops for the day at `dailyUsd`; one number can cause `perNumberPerDay` calls. */
  claudeBudget: { dailyUsd: number; perNumberPerDay: number };
  /** Use draft lexicon words (the unreviewed Shona and Ndebele lists) as if a native speaker had approved them. */
  lexiconTrustDrafts: boolean;
  /** When a person answers chats handed to the team, so customers are told when to expect a reply. */
  teamHours: TeamHours;
  /** Read field agents' price-list photos through the Batch API (half price, results within hours). */
  priceListBatch: boolean;
  /** The local engine's thresholds: unknown words allowed in a straight answer, and the classifier's bar. */
  local: LocalSettings;
  /** Speech-to-text for voice notes: Google Chirp 2, or any service behind the HTTP contract in src/ai/speech.ts. */
  speech: {
    url?: string;
    token?: string;
    languages: string[];
    google?: { projectId: string; location: string; languages: string[]; credentialsFile?: string; credentialsJson?: string };
  };
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
  limits: { perMinute: number; perDay: number; mediaPerDay: number; reportsPerDay: number; reportsToPause: number };
  /** How long conversation data is kept. */
  retention: { messageDays: number; requestDays: number };
  opsSessionHours: number;
  /** Largest photo or voice note we download. */
  maxMediaBytes: number;
  whatsapp: {
    transport: "simulator" | "cloud";
    graphVersion: string;
    accessToken?: string;
    appSecret?: string;
    verifyToken?: string;
    phoneNumberIds: { customer: string; business: string };
    numbers: { customer: string; business: string };
    /** WhatsApp Business Account ID, for managing message templates. */
    businessAccountId?: string;
    templates: {
      language: string;
      leadNotification: string;
      followUp: string;
      weeklySummary: string;
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
    uploadsDir: e.UPLOADS_DIR,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ""),
    seedSampleData: e.SEED_SAMPLE_DATA,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeModel: e.CLAUDE_MODEL,
    claudeBudget: { dailyUsd: e.CLAUDE_DAILY_BUDGET_USD, perNumberPerDay: e.CLAUDE_CALLS_PER_NUMBER_PER_DAY },
    lexiconTrustDrafts: e.LEXICON_TRUST_DRAFTS,
    teamHours: parseTeamHours(e.TEAM_HOURS),
    priceListBatch: e.PRICE_LIST_BATCH,
    local: { unknownWords: parseUnknownWords(e.LOCAL_UNKNOWN_WORDS), classifierMin: e.LOCAL_CLASSIFIER_MIN },
    speech: {
      url: e.SPEECH_TO_TEXT_URL,
      token: e.SPEECH_TO_TEXT_TOKEN,
      languages: list(e.SPEECH_LANGUAGES),
      google: e.GOOGLE_STT_PROJECT
        ? {
            projectId: e.GOOGLE_STT_PROJECT,
            location: e.GOOGLE_STT_LOCATION,
            languages: list(e.GOOGLE_STT_LANGUAGES),
            credentialsFile: e.GOOGLE_APPLICATION_CREDENTIALS,
            credentialsJson: e.GOOGLE_SERVICE_ACCOUNT_JSON,
          }
        : undefined,
    },
    maxMediaBytes: Math.round(e.MAX_MEDIA_MB * 1024 * 1024),
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
      mediaPerDay: e.MEDIA_PER_DAY,
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
      phoneNumberIds: {
        customer: e.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID ?? "sim-customer",
        business: e.WHATSAPP_BUSINESS_PHONE_NUMBER_ID ?? "sim-business",
      },
      numbers: { customer: digits(e.WHATSAPP_CUSTOMER_NUMBER), business: digits(e.WHATSAPP_BUSINESS_NUMBER) },
      businessAccountId: e.WHATSAPP_BUSINESS_ACCOUNT_ID,
      templates: {
        language: e.TEMPLATE_LANGUAGE,
        leadNotification: e.TEMPLATE_LEAD_NOTIFICATION,
        followUp: e.TEMPLATE_FOLLOW_UP,
        weeklySummary: e.TEMPLATE_WEEKLY_SUMMARY,
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
  if (c.storage.driver === "s3" && !c.storage.bucket) problems.push("S3_BUCKET is required when STORAGE=s3");
  if (c.speech.google && !c.speech.google.credentialsFile && !c.speech.google.credentialsJson) {
    problems.push("GOOGLE_STT_PROJECT needs GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  if (c.env === "production") {
    if (!c.opsToken) problems.push("OPS_TOKEN is required in production");
    if (!c.databaseUrl) problems.push("DATABASE_URL is required in production (embedded PGlite is for development)");
    if (c.seedSampleData) problems.push("SEED_SAMPLE_DATA must be off in production");
    if (c.whatsapp.transport !== "cloud") problems.push("Production must use the cloud WhatsApp transport");
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
