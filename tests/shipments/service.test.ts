import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";
import { addShipment, markDeliveredSimulated, pushTrackingToPaypal, ShipmentError } from "@/lib/shipments/service";

const PAYPAL_ADDR = { line1: "12 Fern St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };

async function seedOrder(db: Db, over: Partial<typeof orders.$inferInsert> = {}) {
  await db.insert(orders).values({
    id: "ORDER-1",
    source: "human",
    status: "COMPLETED",
    amountCents: 6000,
    currency: "USD",
    shipName: "Sam Buyer",
    shipAddress: PAYPAL_ADDR,
    items: [{ sku: "silver-hoops", name: "Silver hoop earrings", qty: 1, priceCents: 6000 }],
    captureId: "CAP-1",
    ...over,
  });
}

describe("shipments service", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await seedOrder(db);
  });

  it("addShipment defaults the ship-to address to the PayPal address and starts unpushed", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: " 9400111899223 " });
    expect(s.orderId).toBe("ORDER-1");
    expect(s.trackingNumber).toBe("9400111899223");
    expect(s.shipToAddress).toEqual(PAYPAL_ADDR);
    expect(s.pushedToPaypal).toBe(false);
    expect(s.status).toBe("label");
    expect(s.simulated).toBe(false);
  });

  it("addShipment keeps an explicit ship-to address", async () => {
    const other = { ...PAYPAL_ADDR, line1: "99 Other Rd" };
    const s = await addShipment(db, "ORDER-1", { carrier: "UPS", trackingNumber: "1Z999AA10000001", shipToAddress: other });
    expect(s.shipToAddress).toEqual(other);
  });

  it("addShipment rejects an unknown order and a blank tracking number", async () => {
    await expect(addShipment(db, "NOPE", { carrier: "USPS", trackingNumber: "9400111899223" })).rejects.toMatchObject({ code: "not_found" });
    await expect(addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "  " })).rejects.toBeInstanceOf(ShipmentError);
    await expect(addShipment(db, "ORDER-1", { carrier: "", trackingNumber: "123" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("pushTrackingToPaypal sends the tracking to PayPal and marks the shipment pushed", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const addTracking = vi.fn().mockResolvedValue(undefined);
    const now = new Date("2026-11-05T10:00:00Z");
    const r = await pushTrackingToPaypal(db, s.id, { addTracking, now: () => now });
    expect(addTracking).toHaveBeenCalledWith({
      orderId: "ORDER-1",
      captureId: "CAP-1",
      carrier: "USPS",
      trackingNumber: "9400111899223",
      notifyPayer: false,
    });
    expect(r.simulated).toBe(false);
    expect(r.shipment.pushedToPaypal).toBe(true);
    expect(r.shipment.pushedAt?.toISOString()).toBe(now.toISOString());
  });

  it("pushTrackingToPaypal does not call PayPal again for an already pushed shipment", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const addTracking = vi.fn().mockResolvedValue(undefined);
    await pushTrackingToPaypal(db, s.id, { addTracking });
    const again = await pushTrackingToPaypal(db, s.id, { addTracking });
    expect(addTracking).toHaveBeenCalledTimes(1);
    expect(again.alreadyPushed).toBe(true);
  });

  it("pushTrackingToPaypal leaves the shipment unpushed when PayPal fails", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const addTracking = vi.fn().mockRejectedValue(new Error("PayPal 500"));
    await expect(pushTrackingToPaypal(db, s.id, { addTracking })).rejects.toMatchObject({ code: "paypal_failed" });
    const [row] = await db.select().from(shipments).where(eq(shipments.id, s.id));
    expect(row.pushedToPaypal).toBe(false);
  });

  it("pushTrackingToPaypal refuses an order without a PayPal capture", async () => {
    await db.update(orders).set({ captureId: null }).where(eq(orders.id, "ORDER-1"));
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const addTracking = vi.fn();
    await expect(pushTrackingToPaypal(db, s.id, { addTracking })).rejects.toMatchObject({ code: "no_capture" });
    expect(addTracking).not.toHaveBeenCalled();
  });

  it("pushTrackingToPaypal never calls PayPal for a local dev fixture order and says so", async () => {
    await db.update(orders).set({ raw: { devFixture: true } }).where(eq(orders.id, "ORDER-1"));
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const addTracking = vi.fn();
    const r = await pushTrackingToPaypal(db, s.id, { addTracking });
    expect(addTracking).not.toHaveBeenCalled();
    expect(r.simulated).toBe(true);
    expect(r.shipment.pushedToPaypal).toBe(true);
  });

  it("pushTrackingToPaypal rejects an unknown shipment", async () => {
    await expect(pushTrackingToPaypal(db, "nope", { addTracking: vi.fn() })).rejects.toMatchObject({ code: "not_found" });
  });

  it("markDeliveredSimulated marks the shipment delivered, dated and simulated", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const now = new Date("2026-11-06T15:30:00Z");
    const d = await markDeliveredSimulated(db, s.id, now);
    expect(d.status).toBe("delivered");
    expect(d.deliveredAt?.toISOString()).toBe(now.toISOString());
    expect(d.simulated).toBe(true);
    await expect(markDeliveredSimulated(db, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});
