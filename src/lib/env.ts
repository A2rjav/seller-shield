import { z } from "zod";

// .env.example ships empty values ("KEY="); treat empty strings as unset.
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const req = z.preprocess(blank, z.string().min(1));
const opt = z.preprocess(blank, z.string().min(1).optional());

const schema = z.object({
  PAYPAL_CLIENT_ID: req,
  PAYPAL_CLIENT_SECRET: req,
  PAYPAL_API_BASE: z.preprocess(blank, z.string().url().default("https://api-m.sandbox.paypal.com")),
  PAYPAL_WEBHOOK_ID: opt,
  SANDBOX_BUYER_EMAIL: req,
  SANDBOX_BUYER_PASSWORD: req,
  GEMINI_API_KEY: req,
  GEMINI_MODEL: opt,
  GEMINI_MODEL_FAST: opt,
  DATABASE_URL: req,
  APP_BASE_URL: z.preprocess(blank, z.string().url().default("http://localhost:3000")),
  AI_DAILY_CALL_LIMIT: z.preprocess(blank, z.coerce.number().int().positive().default(300)),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated lazily so importing modules never throws when keys are absent (e.g. in tests). */
export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  const isProcess = source === process.env;
  if (isProcess && cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Only key names are reported, never values.
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid or missing environment variables: ${keys.join(", ")}`);
  }
  if (isProcess) cached = parsed.data;
  return parsed.data;
}

export type PaypalConfig = { clientId: string; clientSecret: string; apiBase: string };

const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);

const paypalSchema = z.object({
  PAYPAL_CLIENT_ID: req,
  PAYPAL_CLIENT_SECRET: req,
  PAYPAL_API_BASE: z.preprocess(blank, z.string().url().default("https://api-m.sandbox.paypal.com")),
});

/** Narrow accessor for the PayPal client. Sandbox only: any non-sandbox base URL is refused. */
export function getPaypalConfig(source: Record<string, string | undefined> = process.env): PaypalConfig {
  const parsed = paypalSchema.safeParse(source);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid or missing environment variables: ${keys.join(", ")}`);
  }
  const d = parsed.data;
  const url = new URL(d.PAYPAL_API_BASE);
  if (url.protocol !== "https:" || !SANDBOX_HOSTS.has(url.host)) {
    throw new Error("PAYPAL_API_BASE must be the PayPal sandbox host (this app is sandbox only)");
  }
  return { clientId: d.PAYPAL_CLIENT_ID, clientSecret: d.PAYPAL_CLIENT_SECRET, apiBase: url.origin };
}

export type AiConfig = { apiKey: string; model?: string; modelFast?: string; dailyLimit: number };

const aiSchema = z.object({
  GEMINI_API_KEY: req,
  GEMINI_MODEL: opt,
  GEMINI_MODEL_FAST: opt,
  AI_DAILY_CALL_LIMIT: z.preprocess(blank, z.coerce.number().int().positive().default(300)),
});

/** Narrow accessor: validates only the AI keys so AI code does not need the PayPal/DB keys. */
export function getAiConfig(source: Record<string, string | undefined> = process.env): AiConfig {
  const parsed = aiSchema.safeParse(source);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid or missing environment variables: ${keys.join(", ")}`);
  }
  const d = parsed.data;
  return { apiKey: d.GEMINI_API_KEY, model: d.GEMINI_MODEL, modelFast: d.GEMINI_MODEL_FAST, dailyLimit: d.AI_DAILY_CALL_LIMIT };
}

/** Narrow accessor for the webhook id. Undefined when unset, so callers can fail closed with a clear message. */
export function getWebhookId(source: Record<string, string | undefined> = process.env): string | undefined {
  const v = source.PAYPAL_WEBHOOK_ID?.trim();
  return v ? v : undefined;
}
