import { describe, expect, it } from "vitest";
import { dashboardKpis, readinessCoverage } from "@/lib/dashboard/summary";

const ADDR = { line1: "1 A St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };

describe("readinessCoverage", () => {
  it("counts payment, PayPal address, tracking and delivery for a human order", () => {
    const c = readinessCoverage({ source: "human", captureId: "C1", shipAddress: ADDR, shipments: [], mandate: null });
    expect(c.have).toEqual(["capture", "ship_address"]);
    expect(c.missing).toEqual(["tracking", "delivery"]);
    expect(c.score).toBe(0.5);
  });
  it("is complete once delivered", () => {
    const c = readinessCoverage({
      source: "human", captureId: "C1", shipAddress: ADDR, mandate: null,
      shipments: [{ trackingNumber: "1", status: "delivered", deliveredAt: new Date() }],
    });
    expect(c.score).toBe(1);
  });
  it("needs the mandate and payer approval for an agent order", () => {
    const c = readinessCoverage({
      source: "agent", captureId: "C1", shipAddress: ADDR, mandate: null,
      shipments: [{ trackingNumber: "1", status: "delivered", deliveredAt: new Date() }],
    });
    expect(c.missing).toEqual(["mandate", "payer_approval"]);
    expect(c.score).toBeCloseTo(4 / 6);
    const v = readinessCoverage({
      source: "agent", captureId: "C1", shipAddress: ADDR, mandate: { verified: false },
      shipments: [{ trackingNumber: "1", status: "delivered", deliveredAt: new Date() }],
    });
    expect(v.missing).toEqual([]);
  });
});

describe("dashboardKpis", () => {
  const orders = [
    { id: "A", amountCents: 6000, status: "at_risk" as const, source: "human" as const },
    { id: "B", amountCents: 4800, status: "protected" as const, source: "agent" as const },
    { id: "C", amountCents: 2500, status: "pending" as const, source: "human" as const },
    { id: "D", amountCents: 11800, status: "protected" as const, source: "human" as const },
  ];
  it("sums at-risk orders and open disputes without counting an order twice", () => {
    const k = dashboardKpis(orders, [
      { orderId: "A", amountCents: 6000, status: "WAITING_FOR_SELLER_RESPONSE" },
      { orderId: "C", amountCents: 2500, status: "UNDER_REVIEW" },
      { orderId: "D", amountCents: 11800, status: "RESOLVED" },
    ]);
    expect(k.moneyAtRiskCents).toBe(6000 + 2500);
    expect(k.openDisputes).toBe(2);
    expect(k.protectedPct).toBe(50);
    expect(k.agentOrders).toBe(1);
    expect(k.totalOrders).toBe(4);
  });
  it("handles an empty shop", () => {
    expect(dashboardKpis([], [])).toEqual({ moneyAtRiskCents: 0, protectedPct: null, openDisputes: 0, agentOrders: 0, totalOrders: 0 });
  });
  it("counts a dispute with no linked order", () => {
    expect(dashboardKpis([], [{ orderId: null, amountCents: 900, status: "OPEN" }]).moneyAtRiskCents).toBe(900);
  });
});
