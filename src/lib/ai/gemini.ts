import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { eq, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema, type Db } from "@/lib/db/client";
import { getAiConfig } from "@/lib/env";

export type AskOpts<T> = { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number };

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

export function createAi(deps: { generate: Generate; usageStore: UsageStore; limit: number }) {
  async function askJson<T>(opts: AskOpts<T>): Promise<AskResult<T>> {
    let allowed: boolean;
    try {
      allowed = await deps.usageStore.tryIncrement();
    } catch {
      return { ok: false, reason: "error" };
    }
    if (!allowed) return { ok: false, reason: "cap" };

    let raw: unknown;
    try {
      raw = await deps.generate(opts);
    } catch (err) {
      return isRateLimited(err) ? { ok: false, reason: "error", rateLimited: true } : { ok: false, reason: "error" };
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

/** Newest stable "pro" model that supports generateContent; else newest stable "flash". */
export function pickModel(models: ModelInfo[]): string | undefined {
  const ids = models
    .filter((x) => x.supportedGenerationMethods?.includes("generateContent"))
    .map((x) => x.name.replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-") && !EXCLUDED.some((w) => id.includes(w)) && version(id).length > 0);
  return newest(ids.filter((id) => /-pro(-|$)/.test(id))) ?? newest(ids.filter((id) => /-flash(-|$)/.test(id)));
}

const modelCache: { model?: string } = {};

export async function resolveModel(deps: {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  cache?: { model?: string };
}): Promise<string> {
  if (deps.model) return deps.model;
  const cache = deps.cache ?? modelCache;
  if (cache.model) return cache.model;
  const f = deps.fetchFn ?? fetch;
  const models: ModelInfo[] = [];
  let token: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", deps.apiKey);
    url.searchParams.set("pageSize", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const res = await f(url.toString());
    if (!res.ok) throw new Error(`Gemini model listing failed with HTTP ${res.status}`);
    const body = (await res.json()) as { models?: ModelInfo[]; nextPageToken?: string };
    models.push(...(body.models ?? []));
    token = body.nextPageToken || undefined;
  } while (token);
  const picked = pickModel(models);
  if (!picked) throw new Error("No suitable Gemini model found; set GEMINI_MODEL");
  cache.model = picked;
  return picked;
}

// ---- Production wiring (lazy: nothing reads env at import time) ----

const generateWithGemini: Generate = async ({ system, user, schema: s, maxTokens }) => {
  const cfg = getAiConfig();
  const modelId = await resolveModel({ apiKey: cfg.apiKey, model: cfg.model });
  const google = createGoogleGenerativeAI({ apiKey: cfg.apiKey });
  const { object } = await generateObject({
    model: google(modelId),
    schema: s,
    system,
    prompt: user,
    maxOutputTokens: maxTokens,
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
