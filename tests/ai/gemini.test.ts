import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { NoObjectGeneratedError, TypeValidationError } from "ai";
import { availableModels, createAi, createDbUsageStore, generateWithFallback, generationOptions, noteModelFailure, parseRetryDelayMs, pickFallbacks, pickModel, resolveModel, utcDay, type UsageStore } from "@/lib/ai/gemini";
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

  it("retries an overloaded (503) model once, counting both calls against the cap", async () => {
    const st = store(0);
    const sleep = vi.fn(async () => {});
    let n = 0;
    const ai = createAi({
      generate: async () => {
        if (n++ === 0) throw Object.assign(new Error("This model is currently experiencing high demand."), { statusCode: 503 });
        return { summary: "ok" };
      },
      usageStore: st,
      limit: 300,
      sleep,
    });
    expect(await ai.askJson(opts)).toEqual({ ok: true, data: { summary: "ok" } });
    expect(st.calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up after one overload retry, and never retries past the cap", async () => {
    const overloaded = async () => {
      throw Object.assign(new Error("UNAVAILABLE: high demand"), { statusCode: 503 });
    };
    const a = createAi({ generate: overloaded, usageStore: store(0), limit: 300, sleep: async () => {} });
    expect(await a.askJson(opts)).toEqual({ ok: false, reason: "error" });
    const gen = vi.fn(overloaded);
    const capped = store(299, 300);
    const b = createAi({ generate: gen, usageStore: capped, limit: 300, sleep: async () => {} });
    expect(await b.askJson(opts)).toEqual({ ok: false, reason: "error" });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(capped.calls).toBe(300);
  });

  it("does not retry other errors", async () => {
    const gen = vi.fn(async () => {
      throw new Error("boom");
    });
    const ai = createAi({ generate: gen, usageStore: store(0), limit: 300, sleep: async () => {} });
    await ai.askJson(opts);
    expect(gen).toHaveBeenCalledTimes(1);
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

  it("generationOptions: never retries; low thinking for every Gemini 3+ model (flash included) and a budget for 2.x pro", () => {
    // Live 2026-11-09: gemini-3.5-flash spent ~980 of 1024 output tokens thinking and truncated the JSON without this.
    expect(generationOptions("gemini-3.5-flash")).toEqual({ maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } } });
    expect(generationOptions("gemini-3.1-flash")).toEqual({ maxRetries: 0, providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } } });
    expect(generationOptions("gemini-2.0-flash")).toEqual({ maxRetries: 0 });
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

describe("model fallback on quota (live 2026-11-10: 20 free-tier requests per day per model)", () => {
  const quota429 = Object.assign(new Error("You exceeded your current quota. Please retry in 2h4m10.5s."), { statusCode: 429 });

  it("pickFallbacks lists the newest stable flash-lite models other than the primary", () => {
    const models = [m("gemini-3.5-flash"), m("gemini-3.5-flash-lite"), m("gemini-3.1-flash-lite"), m("gemini-2.5-flash-lite"), m("gemini-3.1-flash-lite-preview"), m("gemini-flash-lite-latest")];
    expect(pickFallbacks(models, "gemini-3.5-flash")).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
    expect(pickFallbacks(models, "gemini-3.5-flash-lite", 5)).toEqual(["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]);
    expect(pickFallbacks([m("gemini-3.5-flash")], "gemini-3.5-flash")).toEqual([]);
  });

  it("parseRetryDelayMs reads Gemini's retry hints", () => {
    expect(parseRetryDelayMs("Please retry in 2h4m10.5s.")).toBe((2 * 3600 + 4 * 60 + 10.5) * 1000);
    expect(parseRetryDelayMs("Please retry in 37.2s")).toBe(37200);
    expect(parseRetryDelayMs('"retryDelay": "7450s"')).toBe(7450000);
    expect(parseRetryDelayMs("nothing here")).toBeUndefined();
  });

  it("noteModelFailure blocks a model on 429 until Gemini's retry time and on 404 for a day; other errors are not noted", () => {
    const blocked = new Map<string, number>();
    expect(noteModelFailure("a", quota429, 1000, blocked)).toBe(true);
    expect(blocked.get("a")).toBe(1000 + (2 * 3600 + 4 * 60 + 10.5) * 1000);
    expect(noteModelFailure("b", Object.assign(new Error("not found"), { statusCode: 404 }), 0, blocked)).toBe(true);
    expect(blocked.get("b")).toBe(24 * 3600_000);
    expect(noteModelFailure("c", Object.assign(new Error("overloaded"), { statusCode: 503 }), 5, blocked)).toBe(true);
    expect(blocked.get("c")).toBe(5 + 30_000);
    expect(noteModelFailure("d", new Error("boom"), 0, blocked)).toBe(false);
    expect(noteModelFailure("", quota429, 0, blocked)).toBe(false);
    expect(blocked.has("d")).toBe(false);
  });

  it("availableModels skips blocked models until they reopen, and keeps the primary when all are blocked", () => {
    const blocked = new Map([["p", 5000]]);
    expect(availableModels(["p", "f1", "f1", "f2"], 1000, blocked)).toEqual(["f1", "f2"]);
    expect(availableModels(["p", "f1"], 6000, blocked)).toEqual(["p", "f1"]);
    blocked.set("f1", 5000);
    expect(availableModels(["p", "f1"], 1000, blocked)).toEqual(["p"]);
  });

  it("generateWithFallback moves to the next model on a noted failure and throws other errors at once", async () => {
    const blocked = new Map<string, number>();
    const note = (id: string, e: unknown) => noteModelFailure(id, e, 0, blocked);
    const call = vi.fn(async (id: string) => {
      if (id === "p") throw quota429;
      return `ok:${id}`;
    });
    expect(await generateWithFallback(["p", "f1"], call, note)).toBe("ok:f1");
    expect(blocked.has("p")).toBe(true);
    await expect(generateWithFallback(["p"], call, note)).rejects.toBe(quota429);
    const boom = new Error("boom");
    const other = vi.fn(async () => { throw boom; });
    await expect(generateWithFallback(["x", "y"], other, note)).rejects.toBe(boom);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("generateWithFallback moves past an overloaded (503) model, blocks it ~30 s, and stays bounded", async () => {
    const blocked = new Map<string, number>();
    const note = (id: string, e: unknown) => noteModelFailure(id, e, 0, blocked);
    const over = Object.assign(new Error("The model is overloaded. Please try again later."), { statusCode: 503 });
    const call = vi.fn(async (id: string) => {
      if (id !== "f2") throw over;
      return `ok:${id}`;
    });
    expect(await generateWithFallback(["p", "f1", "f2"], call, note)).toBe("ok:f2");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["p", "f1", "f2"]);
    expect(blocked.get("p")).toBe(30_000);
    const all = vi.fn(async () => { throw over; });
    await expect(generateWithFallback(["p", "f1"], all, note)).rejects.toBe(over);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("getAiConfig reads GEMINI_MODEL_FALLBACKS as a list", () => {
    expect(getAiConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL_FALLBACKS: " a, b ,," }).modelFallbacks).toEqual(["a", "b"]);
    expect(getAiConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL_FALLBACKS: "" }).modelFallbacks).toBeUndefined();
  });
});
