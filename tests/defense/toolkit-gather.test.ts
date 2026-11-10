import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createToolkitAgent, gatherWithToolkit, redactForModel, type ToolCall } from "@/lib/defense/toolkit-gather";
import type { PaypalDispute } from "@/lib/paypal/disputes";

const dispute = {
  dispute_id: "PP-D-77", create_time: "2026-11-07T08:00:00.000Z", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "60.00" }, seller_response_due_date: "2026-11-14T08:00:00.000Z",
  disputed_transactions: [{ seller_transaction_id: "CAP1" }], dispute_life_cycle_stage: "INQUIRY",
};
const order = {
  id: "ORD1", status: "COMPLETED", create_time: "2026-11-05T10:00:00Z",
  payer: { email_address: "buyer@example.com" },
  purchase_units: [{ amount: { currency_code: "USD", value: "60.00" }, payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "60.00" }, create_time: "2026-11-05T10:01:00Z" }] } }],
};
const tracking = { transaction_id: "CAP1", tracking_number: "9400111899", carrier: "USPS", status: "SHIPPED" };

describe("gatherWithToolkit", () => {
  it("AI path turns toolkit tool results (JSON strings or objects) into paypal evidence items", async () => {
    const calls: ToolCall[] = [
      { tool: "get_dispute", result: JSON.stringify(dispute) },
      { tool: "get_order", result: order },
      { tool: "get_shipment_tracking", result: JSON.stringify(tracking) },
    ];
    const runAgent = vi.fn().mockResolvedValue({ ok: true, calls });
    const getDispute = vi.fn();
    const items = await gatherWithToolkit("PP-D-77", { orderId: "ORD1", runAgent, getDispute });
    expect(getDispute).not.toHaveBeenCalled();
    expect(items.map((i) => i.id)).toEqual([
      "ev:paypal:dispute:PP-D-77", "ev:paypal:order:ORD1", "ev:paypal:capture:CAP1", "ev:paypal:tracking:CAP1",
    ]);
    expect(items.every((i) => i.source === "paypal" && !i.simulated)).toBe(true);
    expect(items[0].summary).toBe(
      "PayPal dispute PP-D-77, opened 2026-11-07, reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED, status WAITING_FOR_SELLER_RESPONSE, amount $60.00, seller response due 2026-11-14",
    );
    expect(items[2].summary).toContain("amount $60.00");
    expect(JSON.stringify(items)).not.toContain("buyer@example.com");
  });

  it("capped AI -> direct REST functions", async () => {
    const runAgent = vi.fn().mockResolvedValue({ ok: false });
    const getDispute = vi.fn().mockResolvedValue(dispute as PaypalDispute);
    const getOrder = vi.fn().mockResolvedValue(order);
    const items = await gatherWithToolkit("PP-D-77", { orderId: "ORD1", runAgent, getDispute, getOrder });
    expect(getDispute).toHaveBeenCalledWith("PP-D-77");
    expect(getOrder).toHaveBeenCalledWith("ORD1");
    expect(items.map((i) => i.kind)).toEqual(["dispute", "order", "capture"]);
  });

  it("agent that throws or returns nothing falls back to REST; unreachable PayPal gives an empty list", async () => {
    const getDispute = vi.fn().mockRejectedValue(new Error("down"));
    expect(await gatherWithToolkit("X", { runAgent: vi.fn().mockRejectedValue(new Error("boom")), getDispute })).toEqual([]);
    const ok = vi.fn().mockResolvedValue(dispute as PaypalDispute);
    const items = await gatherWithToolkit("PP-D-77", { runAgent: vi.fn().mockResolvedValue({ ok: true, calls: [] }), getDispute: ok });
    expect(items).toHaveLength(1);
  });
});

describe("result filtering", () => {
  it("drops tool results for another dispute, another order, or an unrelated transaction", async () => {
    const calls: ToolCall[] = [
      { tool: "get_dispute", result: { ...dispute, dispute_id: "OTHER" } },
      { tool: "get_dispute", result: dispute },
      { tool: "get_order", result: { ...order, id: "ORD-OTHER" } },
      { tool: "get_order", result: order },
      { tool: "get_shipment_tracking", result: { ...tracking, transaction_id: "CAP-OTHER" } },
    ];
    const items = await gatherWithToolkit("PP-D-77", { orderId: "ORD1", runAgent: async () => ({ ok: true, calls }) });
    expect(items.map((i) => i.id)).toEqual(["ev:paypal:dispute:PP-D-77", "ev:paypal:order:ORD1", "ev:paypal:capture:CAP1"]);
  });
});

describe("redactForModel", () => {
  it("keeps ids, amounts and dates but no emails, names or addresses", () => {
    const rich = { ...order, payer: { email_address: "buyer@example.com", name: { given_name: "Bea" } },
      purchase_units: [{ ...order.purchase_units[0], shipping: { name: { full_name: "Bea Buyer" }, address: { address_line_1: "12 Oak St" } } }] };
    const v = JSON.stringify(redactForModel("get_order", JSON.stringify(rich)));
    expect(v).not.toMatch(/@|Bea|Oak/);
    expect(v).toContain("CAP1");
    expect(v).toContain("60.00");
    expect(JSON.stringify(redactForModel("get_dispute", { ...dispute, messages: [{ content: "mail me at x@y.com" }] }))).not.toContain("@");
  });
});

// ---- Agent loop with a scripted model and fake toolkit tools ----
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const callStep = (name: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c-${name}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage, warnings: [],
});
const textStep = { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };

function harness(slots: number, steps: unknown[]) {
  const store = { used: 0 };
  const model = new MockLanguageModelV4({ doGenerate: steps as never });
  const fakeTools = {
    get_dispute: { description: "d", parameters: z.object({ dispute_id: z.string() }), execute: async () => JSON.stringify({ ...dispute, messages: [{ content: "write to a@b.com" }] }) },
    get_order: { description: "o", parameters: z.object({ id: z.string() }), execute: async () => JSON.stringify({ ...order }) },
    get_shipment_tracking: { description: "t", parameters: z.object({ order_id: z.string(), transaction_id: z.string() }), execute: async () => JSON.stringify(tracking) },
    create_refund: { description: "x", parameters: z.object({}), execute: async () => "NO" },
  };
  const agent = createToolkitAgent({
    consume: async () => (store.used < slots ? (store.used++, true) : false),
    loadTools: async () => fakeTools,
    loadModel: async () => model,
  });
  return { agent, store, model };
}

describe("createToolkitAgent", () => {
  it("consumes one cap slot per model step (3 tool steps + final text = 4)", async () => {
    const h = harness(10, [
      callStep("get_dispute", { dispute_id: "PP-D-77" }), callStep("get_order", { id: "ORD1" }),
      callStep("get_shipment_tracking", { order_id: "ORD1", transaction_id: "CAP1" }), textStep,
    ]);
    const r = await h.agent({ disputeId: "PP-D-77", orderId: "ORD1" });
    expect(h.store.used).toBe(4);
    expect(r.ok && r.calls.map((c) => c.tool)).toEqual(["get_dispute", "get_order", "get_shipment_tracking"]);
  });

  it("makes no SDK retries: a retryable model error is one call, not three (I3)", async () => {
    const { APICallError } = await import("ai");
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (async () => {
        calls++;
        throw new APICallError({ message: "overloaded", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      }) as never,
    });
    const agent = createToolkitAgent({ consume: async () => true, loadTools: async () => ({}), loadModel: async () => model, noteFailure: () => false });
    await agent({ disputeId: "PP-D-77" });
    expect(calls).toBe(1);
  });

  it("on a model out of daily quota (429) reruns once on the fallback model before any tool ran", async () => {
    const { APICallError } = await import("ai");
    const quota = new MockLanguageModelV4({
      modelId: "gemini-primary",
      doGenerate: (async () => {
        throw new APICallError({ message: "quota", url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true });
      }) as never,
    });
    const h = harness(10, [callStep("get_dispute", { dispute_id: "PP-D-77" }), textStep]);
    const loadModel = vi.fn().mockResolvedValueOnce(quota).mockResolvedValueOnce(h.model);
    const noteFailure = vi.fn(() => true);
    const tools = { get_dispute: { description: "d", parameters: z.object({ dispute_id: z.string() }), execute: async () => JSON.stringify(dispute) } };
    const agent = createToolkitAgent({ consume: async () => true, loadTools: async () => tools, loadModel, noteFailure });
    const r = await agent({ disputeId: "PP-D-77" });
    expect(noteFailure).toHaveBeenCalledWith("gemini-primary", expect.anything());
    expect(r.ok && r.calls.map((c) => c.tool)).toEqual(["get_dispute"]);
  });

  it("never runs more than 4 steps", async () => {
    const h = harness(100, Array.from({ length: 10 }, () => callStep("get_dispute", { dispute_id: "PP-D-77" })));
    await h.agent({ disputeId: "PP-D-77" });
    expect(h.store.used).toBe(4);
  });

  it("passes the model only redacted tool results, and exposes only read-only tools", async () => {
    const h = harness(10, [callStep("get_dispute", { dispute_id: "PP-D-77" }), textStep]);
    await h.agent({ disputeId: "PP-D-77" });
    const second = JSON.stringify(h.model.doGenerateCalls[1].prompt);
    expect(second).toContain("PP-D-77");
    expect(second).not.toContain("@");
    expect(JSON.stringify(h.model.doGenerateCalls[0].tools)).not.toContain("create_refund");
  });

  it("when the store refuses, the loop stops and gatherWithToolkit falls back to REST", async () => {
    const h = harness(0, [textStep]);
    const getDispute = vi.fn().mockResolvedValue(dispute as PaypalDispute);
    const items = await gatherWithToolkit("PP-D-77", { runAgent: h.agent, getDispute });
    expect(h.model.doGenerateCalls).toHaveLength(0);
    expect(getDispute).toHaveBeenCalledOnce();
    expect(items.map((i) => i.kind)).toEqual(["dispute"]);
  });

  it("when the store refuses mid-loop, results gathered so far are used", async () => {
    const h = harness(1, [callStep("get_dispute", { dispute_id: "PP-D-77" }), textStep]);
    const getDispute = vi.fn();
    const items = await gatherWithToolkit("PP-D-77", { runAgent: h.agent, getDispute });
    expect(h.model.doGenerateCalls).toHaveLength(1);
    expect(getDispute).not.toHaveBeenCalled();
    expect(items.map((i) => i.kind)).toEqual(["dispute"]);
  });
});
