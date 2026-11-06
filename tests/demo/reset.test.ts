import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { fakePaypal, insertMandate } from "./helpers";
import type { Db } from "@/lib/db/client";
import { demoState, disputes, mandates, messages, orders, protectionChecks, shipments } from "@/lib/db/schema";
import { resetCooldownSec, resetDemo } from "@/lib/demo/reset";
import { createSimulatedDispute } from "@/lib/demo/simulate";
import { seedDemo, type BaselineEntry } from "@/lib/demo/seed";
import { recomputeProtection } from "@/lib/protection/refresh";
import { addShipment, pushTrackingToPaypal } from "@/lib/shipments/service";

const ENTRIES: BaselineEntry[] = [
  { orderId: "O-DELIVERED", scenario: "protected_delivered" },
  { orderId: "O-850", scenario: "awaiting_delivery_850" },
  { orderId: "O-DISPUTE", scenario: "dispute_item_not_received" },
  { orderId: "O-NOPUSH", scenario: "tracking_not_pushed" },
];

async function judgeActivity(db: Db) {
  await db.insert(orders).values({ id: "J-1", source: "human", status: "COMPLETED", amountCents: 5000, currency: "USD", items: [], captureId: "CAP-J1" });
  await addShipment(db, "J-1", { carrier: "USPS", trackingNumber: "940011189922300" });
  await db.insert(protectionChecks).values({ orderId: "J-1", result: {} });
  await db.insert(messages).values({ id: "m-j1", orderId: "J-1", author: "buyer", source: "storefront", body: "hi" });
  await insertMandate(db, "mdt_j", "J-1");
  await createSimulatedDispute(db, "J-1", "UNAUTHORISED");
  await createSimulatedDispute(db, "O-DELIVERED", "UNAUTHORISED"); // judge dispute on a baseline order
  await db.insert(messages).values({ id: "m-base", orderId: "O-DELIVERED", author: "buyer", source: "storefront", body: "judge msg" });
}

describe("resetDemo", () => {
  let db: Db;
  let pp: ReturnType<typeof fakePaypal>;
  beforeEach(async () => {
    db = await createTestDb();
    pp = fakePaypal();
    await seedDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    pp.calls.length = 0;
  });

  it("deletes judge orders and simulated disputes, keeps and re-seeds baseline orders, and writes nothing to PayPal", async () => {
    await judgeActivity(db);
    const r = await resetDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    expect(r.ok).toBe(true);
    expect(await db.select().from(orders).where(eq(orders.id, "J-1"))).toHaveLength(0);
    expect(await db.select().from(shipments).where(eq(shipments.orderId, "J-1"))).toHaveLength(0);
    expect(await db.select().from(mandates).where(eq(mandates.id, "mdt_j"))).toHaveLength(0);
    expect((await db.select().from(orders)).map((o) => o.id).sort()).toEqual(["O-850", "O-DELIVERED", "O-DISPUTE", "O-NOPUSH"]);
    const ds = await db.select().from(disputes);
    expect(ds).toHaveLength(1); // only the seeded scenario dispute remains
    expect(ds[0].orderId).toBe("O-DISPUTE");
    expect(await db.select().from(messages).where(eq(messages.id, "m-base"))).toHaveLength(0);
    expect(await db.select().from(shipments).where(eq(shipments.orderId, "O-DELIVERED"))).toHaveLength(1);
    // PayPal untouched: only the seed's getOrder reads, no tracking pushes (already on PayPal)
    expect(pp.calls.every((c) => c.startsWith("getOrder:"))).toBe(true);
    expect(pp.calls.length).toBe(ENTRIES.length);
  });

  it("restores a baseline order's scenario state after a judge changed it", async () => {
    await db.update(shipments).set({ status: "delivered", deliveredAt: new Date() }).where(eq(shipments.orderId, "O-850"));
    await resetDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    const [s] = await db.select().from(shipments).where(eq(shipments.orderId, "O-850"));
    expect(s).toMatchObject({ status: "in_transit", deliveredAt: null, pushedToPaypal: true });
  });

  it("gives the tracking_not_pushed order a fresh unpushed shipment after a judge pushed tracking", async () => {
    const [before] = await db.select().from(shipments).where(eq(shipments.orderId, "O-NOPUSH"));
    await pushTrackingToPaypal(db, before.id, { addTracking: pp.addTracking });
    await recomputeProtection(db, "O-NOPUSH");
    const r = await resetDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    expect(r.ok).toBe(true);
    const rows = await db.select().from(shipments).where(eq(shipments.orderId, "O-NOPUSH"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pushedToPaypal: false, pushSimulated: false, simulated: true });
    expect(rows[0].trackingNumber).not.toBe(before.trackingNumber);
    expect(rows[0].trackingNumber).toMatch(/^\d{22}$/);
    const [chk] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "O-NOPUSH"));
    expect(JSON.stringify(chk.result)).toContain("tracking_not_on_paypal");
  });

  it("keeps scenario shipments with demo tracking numbers flagged simulated after reset", async () => {
    await resetDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    const rows = await db.select().from(shipments);
    expect(rows.length).toBe(ENTRIES.length);
    expect(rows.every((s) => s.simulated)).toBe(true);
  });

  it("fails honestly and frees the cooldown when a baseline order cannot be reloaded", async () => {
    const flaky = async (id: string) => {
      if (id === "O-850") throw new Error("PayPal 503");
      return pp.getOrder(id);
    };
    const r = await resetDemo(db, { getOrder: flaky, addTracking: pp.addTracking, entries: ENTRIES });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "seed_failed") expect(r.warnings.join(" ")).toContain("O-850");
    expect(await resetCooldownSec(db)).toBe(0);
    expect((await resetDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES })).ok).toBe(true);
  });

  it("is refused within 2 minutes of the last reset, with the seconds remaining", async () => {
    expect((await resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES })).ok).toBe(true);
    const again = await resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES });
    expect(again.ok).toBe(false);
    if (!again.ok && again.reason === "throttled") expect(again.retryAfterSec).toBeGreaterThan(100);
    expect(await resetCooldownSec(db)).toBeGreaterThan(100);
    await db.update(demoState).set({ updatedAt: sql`now() - interval '3 minutes'` });
    expect(await resetCooldownSec(db)).toBe(0);
    expect((await resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES })).ok).toBe(true);
  });

  it("concurrent resets run exactly once", async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(() => resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("releases the cooldown if the reset itself fails, so it can be retried", async () => {
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db down"));
    await expect(resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES })).rejects.toThrow("db down");
    spy.mockRestore();
    expect((await resetDemo(db, { getOrder: pp.getOrder, entries: ENTRIES })).ok).toBe(true);
  });
});
