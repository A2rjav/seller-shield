import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";
import { buildEvidenceFolder } from "@/lib/evidence/folder";
import { CARRIERS, parseTracking } from "@/lib/shipments/carriers";
import { addShipment, pushTrackingToPaypal } from "@/lib/shipments/service";

const ADDR = { line1: "12 Fern St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };

async function seedOrder(db: Db, id = "ORDER-1", raw: unknown = null) {
  await db.insert(orders).values({
    id, source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD",
    shipAddress: ADDR, items: [], captureId: `CAP-${id}`, raw,
  });
}

describe("tracking input validation", () => {
  it("accepts only the supported carriers", () => {
    expect(CARRIERS).toEqual(["USPS", "UPS", "FEDEX", "DHL"]);
    expect(parseTracking({ carrier: "USPS", trackingNumber: " 9400111899223 " })).toEqual({ carrier: "USPS", trackingNumber: "9400111899223" });
    expect(parseTracking({ carrier: "ACME_EXPRESS", trackingNumber: "9400111899223" })).toBeNull();
    expect(parseTracking({ carrier: "usps", trackingNumber: "9400111899223" })).toBeNull();
  });
  it("requires an 8-40 character alphanumeric tracking number", () => {
    expect(parseTracking({ carrier: "UPS", trackingNumber: "1Z999AA1" })).not.toBeNull();
    expect(parseTracking({ carrier: "UPS", trackingNumber: "1234567" })).toBeNull();
    expect(parseTracking({ carrier: "UPS", trackingNumber: "A".repeat(41) })).toBeNull();
    expect(parseTracking({ carrier: "UPS", trackingNumber: "9400-1118-99" })).toBeNull();
    expect(parseTracking({ carrier: "UPS", trackingNumber: "9400 1118 99" })).toBeNull();
    expect(parseTracking({ carrier: "UPS", trackingNumber: 12345678 })).toBeNull();
  });
});

describe("one shipment per order", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await seedOrder(db);
  });

  it("addShipment rejects an unsupported carrier or a malformed tracking number", async () => {
    await expect(addShipment(db, "ORDER-1", { carrier: "ACME", trackingNumber: "9400111899223" })).rejects.toMatchObject({ code: "invalid" });
    await expect(addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "123" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("a new tracking number replaces an unpushed shipment in place", async () => {
    const first = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "WRONG12345" });
    const second = await addShipment(db, "ORDER-1", { carrier: "UPS", trackingNumber: "1Z999AA10000001" });
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(shipments).where(eq(shipments.orderId, "ORDER-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ carrier: "UPS", trackingNumber: "1Z999AA10000001", pushedToPaypal: false });
  });

  it("a shipment rejected by PayPal stays unpushed and can be corrected", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "BADNUMBER1" });
    await expect(pushTrackingToPaypal(db, s.id, { addTracking: vi.fn().mockRejectedValue(new Error("422")) })).rejects.toMatchObject({ code: "paypal_failed" });
    const fixed = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const ok = vi.fn().mockResolvedValue(undefined);
    const r = await pushTrackingToPaypal(db, fixed.id, { addTracking: ok });
    expect(ok).toHaveBeenCalledWith(expect.objectContaining({ trackingNumber: "9400111899223" }));
    expect(r.shipment.pushedToPaypal).toBe(true);
  });

  it("refuses to replace a shipment already on PayPal", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    await pushTrackingToPaypal(db, s.id, { addTracking: vi.fn().mockResolvedValue(undefined) });
    await expect(addShipment(db, "ORDER-1", { carrier: "UPS", trackingNumber: "1Z999AA10000001" })).rejects.toMatchObject({ code: "already_pushed" });
  });

  it("concurrent adds still leave exactly one shipment (unique order_id)", async () => {
    await Promise.allSettled([
      addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "AAAA11111111" }),
      addShipment(db, "ORDER-1", { carrier: "UPS", trackingNumber: "BBBB22222222" }),
      addShipment(db, "ORDER-1", { carrier: "DHL", trackingNumber: "CCCC33333333" }),
    ]);
    expect(await db.select().from(shipments).where(eq(shipments.orderId, "ORDER-1"))).toHaveLength(1);
    await expect(
      db.insert(shipments).values({ id: "dup", orderId: "ORDER-1", carrier: "USPS", trackingNumber: "DDDD44444444" }),
    ).rejects.toThrow();
  });
});

describe("simulated pushes are labelled in the evidence", () => {
  it("a dev-fixture push is marked simulated and says so", async () => {
    const db = await createTestDb();
    await seedOrder(db, "FIX-1", { devFixture: true });
    const s = await addShipment(db, "FIX-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const r = await pushTrackingToPaypal(db, s.id, { addTracking: vi.fn() });
    expect(r.shipment.pushSimulated).toBe(true);
    const item = (await buildEvidenceFolder(db, { orderId: "FIX-1" })).find((i) => i.kind === "tracking")!;
    expect(item.simulated).toBe(true);
    expect(item.summary).toContain("Simulated push to PayPal");
  });

  it("a real push is not marked simulated", async () => {
    const db = await createTestDb();
    await seedOrder(db, "REAL-1");
    const s = await addShipment(db, "REAL-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    const r = await pushTrackingToPaypal(db, s.id, { addTracking: vi.fn().mockResolvedValue(undefined) });
    expect(r.shipment.pushSimulated).toBe(false);
    const item = (await buildEvidenceFolder(db, { orderId: "REAL-1" })).find((i) => i.kind === "tracking")!;
    expect(item.simulated).toBe(false);
    expect(item.summary).not.toContain("Simulated");
    expect(item.summary).toContain("tracking pushed to PayPal");
  });
});
