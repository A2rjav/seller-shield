import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { buildShopperTools, runShopperChat, runWithoutAi, type AgentEvent } from "@/lib/agent/shopper-agent";
import { keyPair, NOW, signed } from "./helpers";

let shopper: Awaited<ReturnType<typeof keyPair>>;
let agent: Awaited<ReturnType<typeof keyPair>>;
beforeAll(async () => {
  shopper = await keyPair();
  agent = await keyPair();
});

const mk = async () => {
  const db = await createTestDb();
  const s = await signed(shopper, agent);
  const createOrder = vi.fn().mockResolvedValue({ id: "PP-9", approveUrl: "https://paypal.test/approve/PP-9" });
  const checkoutDeps = { createOrder, agentPublicJwk: agent.pub as JsonWebKey, now: () => NOW, baseUrl: "http://localhost:3000" };
  const agentSigner = { agentId: "shopper-agent-demo-1", privateKey: agent.priv };
  return { db, s, createOrder, checkoutDeps, agentSigner };
};
type Exec = (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
const run = (t: unknown, args: unknown) => (t as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });

describe("shopper agent tools", () => {
  it("search_products returns sku, name and price from the catalog", async () => {
    const { db, s, checkoutDeps, agentSigner } = await mk();
    const events: AgentEvent[] = [];
    const tools = buildShopperTools({ db, shopperJws: s.shopperJws, events, checkoutDeps, agentSigner });
    const r = await run(tools.search_products, { query: "hoop" });
    expect(r.products).toEqual([{ sku: "silver-hoops", name: "Silver hoop earrings", priceCents: 6000 }]);
  });

  it("checkout within the mandate emits a checkout event", async () => {
    const { db, s, checkoutDeps, agentSigner } = await mk();
    const events: AgentEvent[] = [];
    const tools = buildShopperTools({ db, shopperJws: s.shopperJws, events, checkoutDeps, agentSigner });
    const r = await run(tools.checkout, { items: [{ sku: "silver-hoops", qty: 1 }] });
    expect(r).toMatchObject({ ok: true, orderId: "PP-9" });
    expect(events).toEqual([expect.objectContaining({ type: "checkout", orderId: "PP-9", approveUrl: "https://paypal.test/approve/PP-9" })]);
  });

  it("checkout refuses an item outside the mandate and surfaces a refused event", async () => {
    const { db, s, createOrder, checkoutDeps, agentSigner } = await mk();
    const events: AgentEvent[] = [];
    const tools = buildShopperTools({ db, shopperJws: s.shopperJws, events, checkoutDeps, agentSigner });
    const r = await run(tools.checkout, { items: [{ sku: "heirloom-necklace", qty: 1 }] });
    expect(r).toMatchObject({ ok: false });
    expect(events).toEqual([expect.objectContaining({ type: "refused", failures: expect.arrayContaining(["item_not_in_mandate", "amount_over_max"]) })]);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("runShopperChat / runWithoutAi", () => {
  it("returns aiUnavailable when the AI cap refuses the first step", async () => {
    const { db, s, checkoutDeps, agentSigner } = await mk();
    const loadModel = vi.fn();
    const r = await runShopperChat(
      { db, shopperJws: s.shopperJws, messages: [{ role: "user", content: "buy them" }] },
      { consume: async () => false, loadModel, checkoutDeps, agentSigner },
    );
    expect(r).toEqual({ aiUnavailable: true });
  });

  it("reports a malformed mandate without consuming an AI call", async () => {
    const { db, checkoutDeps, agentSigner } = await mk();
    const consume = vi.fn().mockResolvedValue(true);
    const r = await runShopperChat(
      { db, shopperJws: "garbage", messages: [{ role: "user", content: "hi" }] },
      { consume, loadModel: vi.fn(), checkoutDeps, agentSigner },
    );
    expect(r).toMatchObject({ error: expect.any(String) });
    expect(consume).not.toHaveBeenCalled();
  });

  it("runs the exact mandate items deterministically without AI", async () => {
    const { db, s, createOrder, checkoutDeps, agentSigner } = await mk();
    const r = await runWithoutAi({ db, shopperJws: s.shopperJws }, { checkoutDeps, agentSigner });
    expect(r).toEqual({ events: [expect.objectContaining({ type: "checkout", orderId: "PP-9" })] });
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ items: [{ sku: "silver-hoops", qty: 1 }], customId: s.hash }));
  });
});

describe("runShopperChat tool loop", () => {
  it("runs a Gemini-style tool loop: checkout tool call, then text, one cap slot per step", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { db, s, createOrder, checkoutDeps, agentSigner } = await mk();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [{ type: "tool-call", toolCallId: "c1", toolName: "checkout", input: JSON.stringify({ items: [{ sku: "silver-hoops", qty: 1 }] }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] },
        { content: [{ type: "text", text: "Done - approve it in PayPal." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
      ] as never,
    });
    const consume = vi.fn().mockResolvedValue(true);
    const r = await runShopperChat(
      { db, shopperJws: s.shopperJws, messages: [{ role: "user", content: "buy them" }] },
      { consume, loadModel: async () => model, checkoutDeps, agentSigner },
    );
    expect(r).toMatchObject({ text: "Done - approve it in PayPal.", events: [expect.objectContaining({ type: "checkout", orderId: "PP-9" })] });
    expect(consume).toHaveBeenCalledTimes(2);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});

describe("runShopperChat retries", () => {
  it("makes no SDK retries; an overloaded (503) first step is retried once by the app, each try taking a cap slot", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { APICallError } = await import("ai");
    const { db, s, checkoutDeps, agentSigner } = await mk();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (async () => {
        calls++;
        throw new APICallError({ message: "overloaded", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      }) as never,
    });
    const consume = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn(async () => {});
    const r = await runShopperChat(
      { db, shopperJws: s.shopperJws, messages: [{ role: "user", content: "buy" }] },
      { consume, loadModel: async () => model, checkoutDeps, agentSigner, sleep },
    );
    expect(r).toEqual({ aiUnavailable: true });
    expect(calls).toBe(2);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("recovers when the retry after an overload succeeds", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { APICallError } = await import("ai");
    const { db, s, checkoutDeps, agentSigner, createOrder } = await mk();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const steps = [
      { content: [{ type: "tool-call", toolCallId: "c1", toolName: "checkout", input: JSON.stringify({ items: [{ sku: "silver-hoops", qty: 1 }] }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] },
      { content: [{ type: "text", text: "Approve it in PayPal." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    ];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (async () => {
        if (n++ === 0) throw new APICallError({ message: "This model is currently experiencing high demand.", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true });
        return steps[n - 2];
      }) as never,
    });
    const r = await runShopperChat(
      { db, shopperJws: s.shopperJws, messages: [{ role: "user", content: "buy" }] },
      { consume: async () => true, loadModel: async () => model, checkoutDeps, agentSigner, sleep: async () => {} },
    );
    expect(r).toMatchObject({ text: "Approve it in PayPal.", events: [expect.objectContaining({ type: "checkout" })] });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("does not retry other model errors", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { db, s, checkoutDeps, agentSigner } = await mk();
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: (async () => { calls++; throw new Error("boom"); }) as never });
    const r = await runShopperChat(
      { db, shopperJws: s.shopperJws, messages: [{ role: "user", content: "buy" }] },
      { consume: async () => true, loadModel: async () => model, checkoutDeps, agentSigner, sleep: async () => {} },
    );
    expect(r).toEqual({ aiUnavailable: true });
    expect(calls).toBe(1);
  });
});

describe("runShopperChat mid-loop failures are honest", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const searchStep = { content: [{ type: "tool-call", toolCallId: "s1", toolName: "search_products", input: JSON.stringify({ query: "hoop" }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] };
  const input = async () => {
    const m = await mk();
    return { m, args: { db: m.db, shopperJws: m.s.shopperJws, messages: [{ role: "user" as const, content: "buy" }] } };
  };

  it("model throws on step 2 -> aiUnavailable", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { m, args } = await input();
    let n = 0;
    const model = new MockLanguageModelV4({ doGenerate: (async () => { if (n++ === 0) return searchStep; throw new Error("boom"); }) as never });
    const r = await runShopperChat(args, { consume: async () => true, loadModel: async () => model, checkoutDeps: m.checkoutDeps, agentSigner: m.agentSigner });
    expect(r).toEqual({ aiUnavailable: true });
  });

  it("cap refuses on step 2 -> aiUnavailable", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { m, args } = await input();
    const model = new MockLanguageModelV4({ doGenerate: [searchStep] as never });
    let n = 0;
    const r = await runShopperChat(args, { consume: async () => n++ === 0, loadModel: async () => model, checkoutDeps: m.checkoutDeps, agentSigner: m.agentSigner });
    expect(r).toEqual({ aiUnavailable: true });
  });

  it("empty text and no events -> aiUnavailable", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { m, args } = await input();
    const model = new MockLanguageModelV4({ doGenerate: [{ content: [{ type: "text", text: "" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }] as never });
    const r = await runShopperChat(args, { consume: async () => true, loadModel: async () => model, checkoutDeps: m.checkoutDeps, agentSigner: m.agentSigner });
    expect(r).toEqual({ aiUnavailable: true });
  });
});
