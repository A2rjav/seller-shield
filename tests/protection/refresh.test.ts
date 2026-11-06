import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { mandates, orders, protectionChecks } from "@/lib/db/schema";
import { addShipment, markDeliveredSimulated, pushTrackingToPaypal } from "@/lib/shipments/service";
import { gapKey, getOrderExplanation, recomputeProtection } from "@/lib/protection/refresh";
import type { ProtectionResult } from "@/lib/protection/rules";

const ADDR = { line1: "12 Fern St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };

async function seedOrder(db: Db, over: Partial<typeof orders.$inferInsert> = {}) {
  await db.insert(orders).values({
    id: "ORDER-1",
    source: "human",
    status: "COMPLETED",
    amountCents: 6000,
    currency: "USD",
    shipAddress: ADDR,
    items: [{ sku: "silver-hoops", name: "Silver hoop earrings", qty: 1, priceCents: 6000 }],
    captureId: "CAP-1",
    ...over,
  });
}

const push = vi.fn().mockResolvedValue(undefined);

describe("recomputeProtection", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("returns null for an unknown order", async () => {
    expect(await recomputeProtection(db, "NOPE")).toBeNull();
  });

  it("an unshipped order is at risk for missing tracking, and is stored", async () => {
    await seedOrder(db);
    const r = await recomputeProtection(db, "ORDER-1");
    expect(r?.status).toBe("at_risk");
    expect(r?.gaps.map((g) => g.code)).toEqual(["no_tracking"]);
    const [row] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "ORDER-1"));
    expect((row.result as ProtectionResult).status).toBe("at_risk");
  });

  it("walks to protected as tracking is added, pushed and delivered", async () => {
    await seedOrder(db);
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    let r = await recomputeProtection(db, "ORDER-1");
    expect(r?.status).toBe("pending");
    expect(r?.gaps.map((g) => g.code).sort()).toEqual(["no_delivery_confirmation", "tracking_not_on_paypal"]);
    await pushTrackingToPaypal(db, s.id, { addTracking: push });
    await markDeliveredSimulated(db, s.id);
    r = await recomputeProtection(db, "ORDER-1");
    expect(r).toEqual({ status: "protected", gaps: [] });
  });

  it("flags a ship-to address that differs from the PayPal address", async () => {
    await seedOrder(db);
    await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "1", shipToAddress: { ...ADDR, line1: "1 Elsewhere" } });
    const r = await recomputeProtection(db, "ORDER-1");
    expect(r?.gaps.find((g) => g.code === "address_mismatch")?.severity).toBe("high");
  });

  it("uses the mandate verification for an agent order", async () => {
    await seedOrder(db, { source: "agent", mandateId: "M-1" });
    await db.insert(mandates).values({ id: "M-1", orderId: "ORDER-1", payload: {}, shopperJws: "x", agentJws: "y", hash: "h", verified: false });
    let r = await recomputeProtection(db, "ORDER-1");
    expect(r?.gaps.map((g) => g.code)).toContain("agent_mandate_missing_or_failed");
    await db.update(mandates).set({ verified: true }).where(eq(mandates.id, "M-1"));
    r = await recomputeProtection(db, "ORDER-1");
    expect(r?.gaps.map((g) => g.code)).not.toContain("agent_mandate_missing_or_failed");
  });

  it("clears the cached explanation only when the gap set changes", async () => {
    await seedOrder(db);
    await recomputeProtection(db, "ORDER-1");
    const cached = { gapKey: "no_tracking", lines: [], usedFallback: false, explainedAt: new Date().toISOString() };
    await db.update(protectionChecks).set({ explanation: cached }).where(eq(protectionChecks.orderId, "ORDER-1"));
    await recomputeProtection(db, "ORDER-1");
    let [row] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "ORDER-1"));
    expect(row.explanation).toEqual(cached);
    await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "1" });
    await recomputeProtection(db, "ORDER-1");
    [row] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "ORDER-1"));
    expect(row.explanation).toBeNull();
  });
});

describe("gapKey", () => {
  it("is order-independent", () => {
    const a: ProtectionResult = { status: "pending", gaps: [
      { code: "no_delivery_confirmation", severity: "medium", fix: null, basis: "paypal_policy" },
      { code: "tracking_not_on_paypal", severity: "medium", fix: "push_tracking", basis: "seller_shield" },
    ] };
    expect(gapKey(a)).toBe(gapKey({ ...a, gaps: [...a.gaps].reverse() }));
    expect(gapKey({ status: "protected", gaps: [] })).toBe("");
  });
});

describe("getOrderExplanation", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await seedOrder(db);
    await recomputeProtection(db, "ORDER-1");
  });

  const aiLines = { lines: [{ code: "no_tracking" as const, text: "Add tracking soon." }], usedFallback: false };

  it("returns null when the order has no protection check", async () => {
    expect(await getOrderExplanation(db, "NOPE", { explain: vi.fn() })).toBeNull();
  });

  it("asks the AI once and reuses the cached lines while the gaps are unchanged", async () => {
    const explain = vi.fn().mockResolvedValue(aiLines);
    const first = await getOrderExplanation(db, "ORDER-1", { explain });
    const second = await getOrderExplanation(db, "ORDER-1", { explain });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ lines: aiLines.lines, usedFallback: false, cached: false });
    expect(second).toMatchObject({ lines: aiLines.lines, cached: true });
  });

  it("asks again after the gap set changes", async () => {
    const explain = vi.fn().mockResolvedValue(aiLines);
    await getOrderExplanation(db, "ORDER-1", { explain });
    await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "1" });
    await recomputeProtection(db, "ORDER-1");
    await getOrderExplanation(db, "ORDER-1", { explain });
    expect(explain).toHaveBeenCalledTimes(2);
  });

  it("surfaces the AI cap as the fallback reason", async () => {
    const explain = vi.fn().mockResolvedValue({ lines: [{ code: "no_tracking", text: "std" }], usedFallback: true, fallbackReason: "cap" });
    const r = await getOrderExplanation(db, "ORDER-1", { explain });
    expect(r).toMatchObject({ usedFallback: true, fallbackReason: "cap" });
  });

  it("retries a fallback explanation after 10 minutes, but not before", async () => {
    let t = new Date("2026-11-06T10:00:00Z").getTime();
    const now = () => new Date(t);
    const explain = vi.fn().mockResolvedValue({ lines: [{ code: "no_tracking", text: "std" }], usedFallback: true, fallbackReason: "error" });
    await getOrderExplanation(db, "ORDER-1", { explain, now });
    t += 5 * 60_000;
    await getOrderExplanation(db, "ORDER-1", { explain, now });
    expect(explain).toHaveBeenCalledTimes(1);
    t += 6 * 60_000;
    await getOrderExplanation(db, "ORDER-1", { explain, now });
    expect(explain).toHaveBeenCalledTimes(2);
  });

  it("makes no AI call for a protected order", async () => {
    const s = await addShipment(db, "ORDER-1", { carrier: "USPS", trackingNumber: "1" });
    await pushTrackingToPaypal(db, s.id, { addTracking: push });
    await markDeliveredSimulated(db, s.id);
    await recomputeProtection(db, "ORDER-1");
    const explain = vi.fn();
    const r = await getOrderExplanation(db, "ORDER-1", { explain });
    expect(explain).not.toHaveBeenCalled();
    expect(r).toMatchObject({ lines: [], usedFallback: false });
  });
});
