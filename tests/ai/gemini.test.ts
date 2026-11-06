import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { NoObjectGeneratedError, TypeValidationError } from "ai";
import { createAi, createDbUsageStore, generationOptions, pickModel, resolveModel, utcDay, type UsageStore } from "@/lib/ai/gemini";
import { getAiConfig } from "@/lib/env";
import { createTestDb } from "../helpers/testDb";

const schema = z.object({ summary: z.string() });
const opts = { system: "s", user: "u", schema };

function store(initial: number, limit = 300): UsageStore & { calls: number } {
  const s = {
    calls: initial,
    async tryIncrement() {
      if (s.calls >= limit) return false;
      s.calls += 1;
      return true;
    },
    async callsToday() {
      return s.calls;
    },
  };
  return s;
}

describe("createAi", () => {
  it("returns cap without calling the model when limit reached", async () => {
    const generate = vi.fn();
    const ai = createAi({ generate, usageStore: store(300), limit: 300 });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "cap" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns invalid when model output fails schema", async () => {
    const ai = createAi({ generate: async () => ({ nope: 1 }), usageStore: store(0), limit: 300 });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns data on valid JSON (object or JSON string)", async () => {
    const a = createAi({ generate: async () => ({ summary: "hi" }), usageStore: store(0), limit: 300 });
    expect(await a.askJson(opts)).toEqual({ ok: true, data: { summary: "hi" } });
    const b = createAi({ generate: async () => '{"summary":"yo"}', usageStore: store(0), limit: 300 });
    expect(await b.askJson(opts)).toEqual({ ok: true, data: { summary: "yo" } });
  });

  it("counts a call even when the model errors", async () => {
    const st = store(0);
    const ai = createAi({
      generate: async () => {
        throw new Error("boom");
      },
      usageStore: st,
      limit: 300,
    });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "error" });
    expect(st.calls).toBe(1);
  });

  it("flags rate limiting (429) on errors", async () => {
    const ai = createAi({
      generate: async () => {
        throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
      },
      usageStore: store(0),
      limit: 300,
    });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "error", rateLimited: true });
  });

  it("maps the AI SDK's NoObjectGeneratedError to invalid, so the caller's retry path runs (I3)", async () => {
    const err = new NoObjectGeneratedError({
      message: "No object generated: could not parse the response.",
      text: "{not json",
      response: { id: "r", timestamp: new Date(0), modelId: "m" },
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined } as never,
      finishReason: "stop" as never,
    });
    const ai = createAi({ generate: async () => { throw err; }, usageStore: store(0), limit: 300 });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "invalid" });
  });

  it("maps a schema validation failure thrown by the SDK to invalid (I3)", async () => {
    const err = new TypeValidationError({ value: { nope: 1 }, cause: new Error("bad shape") });
    const ai = createAi({ generate: async () => { throw err; }, usageStore: store(0), limit: 300 });
    expect(await ai.askJson(opts)).toEqual({ ok: false, reason: "invalid" });
  });

  it("passes the tier to the model call: fast unless the caller asks for quality (I3)", async () => {
    const generate = vi.fn(async () => ({ summary: "x" }));
    const ai = createAi({ generate, usageStore: store(0), limit: 300 });
    await ai.askJson(opts);
    await ai.askJson({ ...opts, tier: "quality" });
    expect((generate.mock.calls[0] as unknown[])[0]).toMatchObject({ tier: "fast" });
    expect((generate.mock.calls[1] as unknown[])[0]).toMatchObject({ tier: "quality" });
  });

  it("aiCallsToday reads the store", async () => {
    const ai = createAi({ generate: vi.fn(), usageStore: store(7), limit: 300 });
    expect(await ai.aiCallsToday()).toBe(7);
  });
});

describe("createDbUsageStore", () => {
  it("increments atomically and stops at the cap", async () => {
    const db = await createTestDb();
    const s = createDbUsageStore(db, 3, () => new Date("2026-11-05T10:00:00Z"));
    expect(await s.callsToday()).toBe(0);
    expect(await s.tryIncrement()).toBe(true);
    expect(await s.tryIncrement()).toBe(true);
    expect(await s.tryIncrement()).toBe(true);
    expect(await s.tryIncrement()).toBe(false);
    expect(await s.callsToday()).toBe(3);
  });

  it("concurrent calls never exceed the cap, and a new UTC day resets", async () => {
    const db = await createTestDb();
    const s = createDbUsageStore(db, 5, () => new Date("2026-11-05T23:59:00Z"));
    const results = await Promise.all(Array.from({ length: 12 }, () => s.tryIncrement()));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await s.callsToday()).toBe(5);
    const next = createDbUsageStore(db, 5, () => new Date("2026-11-06T00:00:01Z"));
    expect(await next.callsToday()).toBe(0);
    expect(await next.tryIncrement()).toBe(true);
  });

  it("utcDay formats YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date("2026-11-05T23:59:59Z"))).toBe("2026-11-05");
  });
});

const m = (name: string, methods: string[] = ["generateContent"]) => ({ name: `models/${name}`, supportedGenerationMethods: methods });
const fixture = [
  m("gemini-2.5-pro"),
  m("gemini-3.1-pro"),
  m("gemini-3.1-pro-preview-0915"),
  m("gemini-3.1-flash"),
  m("gemini-4.0-pro-tts"),
  m("gemini-embedding-001", ["embedContent"]),
];

describe("model resolution", () => {
  it("pickModel prefers the newest stable pro", () => {
    expect(pickModel(fixture)).toBe("gemini-3.1-pro");
  });

  it("pickModel falls back to newest stable flash when no stable pro", () => {
    expect(pickModel([m("gemini-2.5-flash"), m("gemini-3.0-flash"), m("gemini-3.5-pro-preview")])).toBe("gemini-3.0-flash");
  });

  it("pickModel returns undefined when nothing fits", () => {
    expect(pickModel([m("gemini-3-pro-preview")])).toBeUndefined();
  });

  it("pickModel fast tier picks the newest stable flash; quality the newest stable pro (I3)", () => {
    expect(pickModel(fixture, "fast")).toBe("gemini-3.1-flash");
    expect(pickModel(fixture, "quality")).toBe("gemini-3.1-pro");
    expect(pickModel([m("gemini-2.5-pro")], "fast")).toBe("gemini-2.5-pro"); // no flash: use what exists
  });

  it("each tier uses its env override without fetching (I3)", async () => {
    const fetchFn = vi.fn();
    expect(await resolveModel({ apiKey: "k", tier: "fast", model: "custom-pro", modelFast: "custom-flash", fetchFn: fetchFn as never })).toBe("custom-flash");
    expect(await resolveModel({ apiKey: "k", tier: "quality", model: "custom-pro", modelFast: "custom-flash", fetchFn: fetchFn as never })).toBe("custom-pro");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("both tiers share one cached model listing (I3)", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ models: fixture })));
    const cache = {};
    expect(await resolveModel({ apiKey: "k", tier: "fast", fetchFn: fetchFn as never, cache })).toBe("gemini-3.1-flash");
    expect(await resolveModel({ apiKey: "k", tier: "quality", fetchFn: fetchFn as never, cache })).toBe("gemini-3.1-pro");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("generationOptions: never retries; a low thinking setting only for pro models (I3)", () => {
    expect(generationOptions("gemini-3.1-flash")).toEqual({ maxRetries: 0 });
    expect(generationOptions("gemini-3.1-pro")).toEqual({ maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } } });
    expect(generationOptions("gemini-2.5-pro")).toEqual({ maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } } });
  });

  it("uses GEMINI_MODEL when set, without fetching", async () => {
    const fetchFn = vi.fn();
    expect(await resolveModel({ apiKey: "k", model: "custom-model", fetchFn: fetchFn as never })).toBe("custom-model");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("lists models with pagination once and caches", async () => {
    const pages = [{ models: fixture.slice(0, 2), nextPageToken: "t2" }, { models: fixture.slice(2) }];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(pages.shift())));
    const deps = { apiKey: "k", fetchFn: fetchFn as never, cache: {} };
    expect(await resolveModel(deps)).toBe("gemini-3.1-pro");
    expect(await resolveModel(deps)).toBe("gemini-3.1-pro");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String((fetchFn.mock.calls[1] as unknown[])[0])).toContain("pageToken=t2");
  });

  it("throws without leaking the key when the listing fails", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(resolveModel({ apiKey: "SECRETKEY", fetchFn: fetchFn as never, cache: {} })).rejects.toThrow(/403/);
    await expect(resolveModel({ apiKey: "SECRETKEY", fetchFn: fetchFn as never, cache: {} })).rejects.not.toThrow(/SECRETKEY/);
  });
});

describe("getAiConfig", () => {
  it("defaults the limit and treats blanks as unset", () => {
    expect(getAiConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL: "", AI_DAILY_CALL_LIMIT: "" })).toEqual({
      apiKey: "k",
      model: undefined,
      modelFast: undefined,
      dailyLimit: 300,
    });
    expect(getAiConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL_FAST: "f" }).modelFast).toBe("f");
  });
  it("requires the key and names it without values", () => {
    expect(() => getAiConfig({})).toThrow(/GEMINI_API_KEY/);
  });
});
