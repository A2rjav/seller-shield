import { generateObject, JSONParseError, NoObjectGeneratedError, TypeValidationError } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { eq, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema, type Db } from "@/lib/db/client";
import { getAiConfig } from "@/lib/env";

/** "fast": newest stable flash (explanations, tool loops). "quality": newest stable pro (the case writer). */
export type ModelTier = "fast" | "quality";

export type AskOpts<T> = { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number; tier?: ModelTier };

export type AskResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "cap" | "invalid" }
  | { ok: false; reason: "error"; rateLimited?: true };

/** Model call. Returns the raw model output: an object, or a JSON string. */
export type Generate = (opts: {
  system: string;
  user: string;
  schema: z.ZodType<unknown>;
  maxTokens?: number;
  tier: ModelTier;
}) => Promise<unknown>;

export type UsageStore = {
  /** Atomically count one call for today (UTC). False (and no increment) when the cap is reached. */
  tryIncrement(): Promise<boolean>;
  callsToday(): Promise<number>;
};

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function createDbUsageStore(db: Db, limit: number, now: () => Date = () => new Date()): UsageStore {
  const { aiUsage } = schema;
  return {
    async tryIncrement() {
      // Single statement: insert day=1, or bump only while calls < limit. Concurrent callers cannot overshoot.
      const rows = await db
        .insert(aiUsage)
        .values({ day: utcDay(now()), calls: 1 })
        .onConflictDoUpdate({
          target: aiUsage.day,
          set: { calls: sql`${aiUsage.calls} + 1` },
          setWhere: lt(aiUsage.calls, limit),
        })
        .returning({ calls: aiUsage.calls });
      return rows.length > 0;
    },
    async callsToday() {
      const rows = await db.select({ calls: aiUsage.calls }).from(aiUsage).where(eq(aiUsage.day, utcDay(now())));
      return rows[0]?.calls ?? 0;
    },
  };
}

function isRateLimited(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string; lastError?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.statusCode === 429 || e.status === 429) return true;
  if (e.lastError && isRateLimited(e.lastError)) return true;
  return /\b429\b|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(String(e.message ?? ""));
}

/** Gemini's transient "model is overloaded" answer (HTTP 503 / UNAVAILABLE / "high demand"), common on the free tier. */
export function isOverloaded(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string; lastError?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.statusCode === 503 || e.status === 503) return true;
  if (e.lastError && isOverloaded(e.lastError)) return true;
  return /\b503\b|UNAVAILABLE|overloaded|high demand/i.test(String(e.message ?? ""));
}

/** The model answered, but not with an object of the required shape: the caller may retry with feedback. */
function isInvalidOutput(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) || TypeValidationError.isInstance(err) || JSONParseError.isInstance(err);
}

/** Wait before the single retry of an overloaded call. */
export const OVERLOAD_RETRY_MS = 2000;

export function createAi(deps: { generate: Generate; usageStore: UsageStore; limit: number; sleep?: (ms: number) => Promise<void> }) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function askJson<T>(opts: AskOpts<T>): Promise<AskResult<T>> {
    let raw: unknown;
    // An overloaded model (503) gets one more try. Each try is a real model call, so each one takes a slot of the daily cap.
    for (let attempt = 0; ; attempt++) {
      let allowed: boolean;
      try {
        allowed = await deps.usageStore.tryIncrement();
      } catch {
        return { ok: false, reason: "error" };
      }
      if (!allowed) return attempt === 0 ? { ok: false, reason: "cap" } : { ok: false, reason: "error" };
      try {
        raw = await deps.generate({ ...opts, tier: opts.tier ?? "fast" });
        break;
      } catch (err) {
        if (isInvalidOutput(err)) return { ok: false, reason: "invalid" };
        if (attempt === 0 && isOverloaded(err)) {
          await sleep(OVERLOAD_RETRY_MS);
          continue;
        }
        return isRateLimited(err) ? { ok: false, reason: "error", rateLimited: true } : { ok: false, reason: "error" };
      }
    }
    try {
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      const parsed = opts.schema.safeParse(value);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: "invalid" };
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }
  return { askJson, aiCallsToday: () => deps.usageStore.callsToday() };
}

// ---- Model resolution (no model id is hardcoded) ----

type ModelInfo = { name: string; supportedGenerationMethods?: string[] };
const EXCLUDED = ["preview", "exp", "tts", "image", "embedding", "live", "audio"];

function version(id: string): number[] {
  const m = id.match(/^gemini-(\d+(?:\.\d+)*)/);
  return m ? m[1].split(".").map(Number) : [];
}

function newest(ids: string[]): string | undefined {
  return [...ids].sort((a, b) => {
    const va = version(a);
    const vb = version(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d) return d;
    }
    return 0;
  })[0];
}

const isPro = (id: string) => /-pro(-|$)/.test(id);
const isFlash = (id: string) => /-flash(-|$)/.test(id);

/** Newest stable model that supports generateContent: "quality" prefers pro then flash, "fast" prefers flash then pro. */
export function pickModel(models: ModelInfo[], tier: ModelTier = "quality"): string | undefined {
  const ids = models
    .filter((x) => x.supportedGenerationMethods?.includes("generateContent"))
    .map((x) => x.name.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-") && !EXCLUDED.some((w) => id.includes(w)) && version(id).length > 0);
  const [first, second] = tier === "fast" ? [isFlash, isPro] : [isPro, isFlash];
  return newest(ids.filter(first)) ?? newest(ids.filter(second));
}

/**
 * Per-call settings. maxRetries 0: the daily cap counts real model calls, so the SDK must not retry behind it.
 * Thinking tokens count against maxOutputTokens: Gemini 3+ models (flash too) think by default and, live on
 * gemini-3.5-flash, spent ~980 of a 1024-token budget thinking and truncated the JSON. So every Gemini 3+ model
 * runs at the "low" thinking level; 2.x pro takes a token budget; 2.x flash is left as is.
 */
export function generationOptions(modelId: string): {
  maxRetries: 0;
  providerOptions?: { google: { thinkingConfig: { thinkingLevel: "low" } | { thinkingBudget: number } } };
} {
  const major = version(modelId)[0] ?? 0;
  if (major >= 3) return { maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } } };
  if (isPro(modelId)) return { maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } } };
  return { maxRetries: 0 };
}

type ModelCache = { models?: ModelInfo[] };
const modelCache: ModelCache = {};

export async function resolveModel(deps: {
  apiKey: string;
  tier?: ModelTier;
  /** GEMINI_MODEL: the quality-tier override. */
  model?: string;
  /** GEMINI_MODEL_FAST: the fast-tier override. */
  modelFast?: string;
  fetchFn?: typeof fetch;
  cache?: ModelCache;
}): Promise<string> {
  const tier = deps.tier ?? "quality";
  const override = tier === "fast" ? deps.modelFast : deps.model;
  if (override) return override;
  const cache = deps.cache ?? modelCache;
  if (!cache.models) cache.models = await listModels(deps.apiKey, deps.fetchFn ?? fetch);
  const picked = pickModel(cache.models, tier);
  if (!picked) throw new Error(`No suitable Gemini model found; set ${tier === "fast" ? "GEMINI_MODEL_FAST" : "GEMINI_MODEL"}`);
  return picked;
}

async function listModels(apiKey: string, f: typeof fetch): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let token: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const res = await f(url.toString());
    if (!res.ok) throw new Error(`Gemini model listing failed with HTTP ${res.status}`);
    const body = (await res.json()) as { models?: ModelInfo[]; nextPageToken?: string };
    models.push(...(body.models ?? []));
    token = body.nextPageToken || undefined;
  } while (token);
  return models;
}

const resolveFor = (tier: ModelTier) => {
  const cfg = getAiConfig();
  return resolveModel({ apiKey: cfg.apiKey, tier, model: cfg.model, modelFast: cfg.modelFast });
};

// ---- Production wiring (lazy: nothing reads env at import time) ----

const generateWithGemini: Generate = async ({ system, user, schema: s, maxTokens, tier }) => {
  const cfg = getAiConfig();
  const modelId = await resolveFor(tier);
  const google = createGoogleGenerativeAI({ apiKey: cfg.apiKey });
  const { object } = await generateObject({
    model: google(modelId),
    schema: s,
    system,
    prompt: user,
    maxOutputTokens: maxTokens,
    ...generationOptions(modelId),
  });
  return object;
};

let defaultAi: ReturnType<typeof createAi> | undefined;
function getDefaultAi() {
  if (!defaultAi) {
    const { dailyLimit } = getAiConfig();
    defaultAi = createAi({ generate: generateWithGemini, usageStore: createDbUsageStore(getDb(), dailyLimit), limit: dailyLimit });
  }
  return defaultAi;
}

export function askJson<T>(opts: AskOpts<T>): Promise<AskResult<T>> {
  try {
    return getDefaultAi().askJson(opts);
  } catch {
    return Promise.resolve({ ok: false, reason: "error" });
  }
}

export function aiCallsToday(): Promise<number> {
  return getDefaultAi().aiCallsToday();
}

/** Counts one call against the daily cap (for callers that use the model outside askJson). False when capped or unavailable. */
export async function tryConsumeAiCall(): Promise<boolean> {
  try {
    const { dailyLimit } = getAiConfig();
    return await createDbUsageStore(getDb(), dailyLimit).tryIncrement();
  } catch {
    return false;
  }
}

/** Settings every tool-loop generateText call spreads in: no SDK retries (the cap counts real calls). */
export const TOOL_LOOP_OPTIONS = { maxRetries: 0 } as const;

/** The Gemini model for tool-calling loops (toolkit gather, shopper agent): the fast tier by default. */
export async function getGeminiModel(tier: ModelTier = "fast") {
  const cfg = getAiConfig();
  return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(await resolveFor(tier));
}
