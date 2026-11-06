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
