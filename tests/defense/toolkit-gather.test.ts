import { describe, expect, it, vi } from "vitest";
import { gatherWithToolkit, type ToolCall } from "@/lib/defense/toolkit-gather";
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
