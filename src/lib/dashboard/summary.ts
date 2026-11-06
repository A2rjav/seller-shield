import type { ProtectionResult } from "@/lib/protection/rules";
import { isOpenDispute } from "./view";

export type ReadinessKind = "capture" | "ship_address" | "tracking" | "delivery" | "mandate" | "payer_approval";

export type ReadinessInput = {
  source: "human" | "agent";
  captureId: string | null;
  shipAddress: unknown;
  shipments: { trackingNumber: string | null; status: string; deliveredAt: Date | null }[];
  /** The order's mandate row, if any; its presence (verified or not) is what the evidence folder records. */
  mandate: { verified: boolean } | null;
};

/**
 * "Proof on file" for the orders grid, mirroring which items the evidence folder will hold: payment capture,
 * the PayPal ship address, tracking and delivery; for agent orders also the mandate and payer approval.
 */
export function readinessCoverage(o: ReadinessInput): { have: ReadinessKind[]; missing: ReadinessKind[]; score: number } {
  const present: Record<ReadinessKind, boolean> = {
    capture: !!o.captureId,
    ship_address: !!o.shipAddress,
    tracking: o.shipments.some((s) => !!s.trackingNumber?.trim()),
    delivery: o.shipments.some((s) => s.status === "delivered" && !!s.deliveredAt),
    mandate: !!o.mandate,
    payer_approval: !!o.mandate,
  };
  const needed: ReadinessKind[] = ["capture", "ship_address", "tracking", "delivery"];
  if (o.source === "agent") needed.push("mandate", "payer_approval");
  const have = needed.filter((k) => present[k]);
  const missing = needed.filter((k) => !present[k]);
  return { have, missing, score: have.length / needed.length };
}

export type Kpis = {
  moneyAtRiskCents: number;
  /** Whole percent of orders that are protected; null when there are no orders. */
  protectedPct: number | null;
  openDisputes: number;
  agentOrders: number;
  totalOrders: number;
};

/** Money at risk = at-risk orders plus open disputes, each order counted once. */
export function dashboardKpis(
  orders: { id: string; amountCents: number; status: ProtectionResult["status"] | null; source: "human" | "agent" }[],
  disputes: { orderId: string | null; amountCents: number; status: string }[],
): Kpis {
  const open = disputes.filter((d) => isOpenDispute(d.status));
  const disputedOrders = new Set(open.map((d) => d.orderId).filter((x): x is string => !!x));
  const atRisk = orders.filter((o) => o.status === "at_risk" && !disputedOrders.has(o.id)).reduce((s, o) => s + o.amountCents, 0);
  const disputed = open.reduce((s, d) => s + d.amountCents, 0);
  const protectedCount = orders.filter((o) => o.status === "protected").length;
  return {
    moneyAtRiskCents: atRisk + disputed,
    protectedPct: orders.length ? Math.round((protectedCount / orders.length) * 100) : null,
    openDisputes: open.length,
    agentOrders: orders.filter((o) => o.source === "agent").length,
    totalOrders: orders.length,
  };
}
