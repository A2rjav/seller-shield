import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { mandates, orders } from "@/lib/db/schema";
import { captureAndRecord } from "@/lib/orders/capture";
import { PaypalError } from "@/lib/paypal/client";

const addr = { line1: "1 Main", city: "Portland", state: "OR", postalCode: "97201", countryCode: "US" };
const ppOrder = {
  purchase_units: [{ items: [{ name: "Silver hoop earrings", sku: "silver-hoops", quantity: "2", unit_amount: { value: "60.00" } }] }],
};
const captured = { captureId: "C1", payerEmail: "b@example.com", payerId: "P1", shipName: "B", shipAddress: addr, amountCents: 12000, currency: "USD", status: "COMPLETED" };

describe("captureAndRecord", () => {
  it("captures once; a second call returns the stored order without a second PayPal capture", async () => {
    const db = await createTestDb();
    const deps = { getOrder: vi.fn().mockResolvedValue(ppOrder), captureOrder: vi.fn().mockResolvedValue(captured) };
    const a = await captureAndRecord(db, "O1", deps);
    const b = await captureAndRecord(db, "O1", deps);
    expect(deps.captureOrder).toHaveBeenCalledTimes(1);
    expect(a.id).toBe(b.id);
    expect(a.source).toBe("human");
    expect(a.items).toEqual([{ sku: "silver-hoops", name: "Silver hoop earrings", qty: 2, priceCents: 6000 }]);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("treats an order with a mandates row as an agent order", async () => {
    const db = await createTestDb();
    await db.insert(mandates).values({
      id: "m-9", orderId: "O2", shopperJws: "a", agentJws: "b", hash: "h", verified: true,
      payload: { shopperEmail: "b@example.com" },
    });
    const deps = { getOrder: vi.fn().mockResolvedValue(ppOrder), captureOrder: vi.fn().mockResolvedValue(captured) };
    const o = await captureAndRecord(db, "O2", deps);
    expect(o.source).toBe("agent");
    expect(o.mandateId).toBe("m-9");
  });
});

describe("captureAndRecord recovery", () => {
  const withCapture = {
    payer: { email_address: "b@example.com", payer_id: "P1" },
    purchase_units: [{
      items: ppOrder.purchase_units[0].items,
      payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { value: "120.00", currency_code: "USD" } }] },
    }],
  };

  it("capture throws ORDER_ALREADY_CAPTURED and PayPal holds a capture -> recorded and returned", async () => {
    const db = await createTestDb();
    const err = new PaypalError({ status: 422, name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
    const deps = { getOrder: vi.fn().mockResolvedValueOnce(ppOrder).mockResolvedValueOnce(withCapture), captureOrder: vi.fn().mockRejectedValue(err) };
    const o = await captureAndRecord(db, "O3", deps);
    expect(o.status).toBe("COMPLETED");
    expect(o.captureId).toBe("C1");
    expect(o.amountCents).toBe(12000);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("capture throws and PayPal has no capture -> error propagates, nothing recorded", async () => {
    const db = await createTestDb();
    const err = new PaypalError({ status: 422, name: "UNPROCESSABLE_ENTITY" });
    const deps = { getOrder: vi.fn().mockResolvedValue(ppOrder), captureOrder: vi.fn().mockRejectedValue(err) };
    await expect(captureAndRecord(db, "O4", deps)).rejects.toBe(err);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});
