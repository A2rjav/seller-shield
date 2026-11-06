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
