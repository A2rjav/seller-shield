import { desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cases, disputes, mandates, orders, protectionChecks, shipments } from "@/lib/db/schema";
import type { Action } from "@/lib/defense/recommend";
import type { StoredRecommendation } from "@/lib/defense/build-case";
import { FALLBACK_TEXT } from "@/lib/protection/explain";
import type { Gap, ProtectionResult } from "@/lib/protection/rules";
import { isDevFixture } from "@/lib/shipments/service";
import { readinessCoverage, type ReadinessKind } from "./summary";
import { isOpenDispute, mandateStateOf, reasonLabel, type MandateState } from "./view";

/** One orders-grid row. Plain JSON so it can cross to the client grid. */
export type OrderRow = {
  id: string;
  createdAt: string;
  buyer: string;
  buyerEmail: string | null;
  amountCents: number;
  currency: string;
  source: "human" | "agent";
  mandate: MandateState | null;
  status: ProtectionResult["status"] | null;
  gaps: Gap[];
  firstGapText: string | null;
  fix: Gap["fix"];
  hasShipment: boolean;
  /** A delivered shipment whose delivery confirmation is simulated (demo carrier). */
  deliverySimulated: boolean;
  coverage: { score: number; missing: ReadinessKind[] };
  dispute: { id: string; status: string; reason: string; simulated: boolean } | null;
  devFixture: boolean;
};

const severityRank = (g: Gap) => (g.severity === "high" ? 0 : 1);

export function sortGaps(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => severityRank(a) - severityRank(b));
}

/** All orders for the grid, newest first, in a fixed number of queries. */
export async function listOrderRows(db: Db): Promise<OrderRow[]> {
  const os = await db.select().from(orders).orderBy(desc(orders.createdAt));
  if (os.length === 0) return [];
  const ids = os.map((o) => o.id);
  const mandateIds = os.map((o) => o.mandateId).filter((x): x is string => !!x);
  const [checks, ships, mands, disps] = await Promise.all([
    db.select().from(protectionChecks).where(inArray(protectionChecks.orderId, ids)),
    db.select().from(shipments).where(inArray(shipments.orderId, ids)),
    db
      .select({ id: mandates.id, orderId: mandates.orderId, verified: mandates.verified })
      .from(mandates)
      .where(or(inArray(mandates.orderId, ids), inArray(mandates.id, mandateIds))),
    db.select().from(disputes).where(inArray(disputes.orderId, ids)),
  ]);

  return os.map((o) => {
    const result = (checks.find((c) => c.orderId === o.id)?.result ?? null) as ProtectionResult | null;
    const gaps = sortGaps(result?.gaps ?? []);
    const orderShips = ships.filter((s) => s.orderId === o.id);
    const mandate = mands.find((m) => m.orderId === o.id || (o.mandateId && m.id === o.mandateId)) ?? null;
    const cov = readinessCoverage({ source: o.source, captureId: o.captureId, shipAddress: o.shipAddress, shipments: orderShips, mandate });
    const d = disps.filter((x) => x.orderId === o.id).sort((a, b) => (b.lastEventAt?.getTime() ?? 0) - (a.lastEventAt?.getTime() ?? 0))[0];
    return {
      id: o.id,
      createdAt: o.createdAt.toISOString(),
      buyer: o.shipName ?? o.buyerEmail ?? "Unknown buyer",
      buyerEmail: o.buyerEmail,
      amountCents: o.amountCents,
      currency: o.currency,
      source: o.source,
      mandate: o.source === "agent" ? mandateStateOf(mandate) : null,
      status: result?.status ?? null,
      gaps,
      firstGapText: gaps[0] ? FALLBACK_TEXT[gaps[0].code] : null,
      fix: gaps.find((g) => g.fix)?.fix ?? null,
      hasShipment: orderShips.length > 0,
      deliverySimulated: orderShips.some((s) => s.status === "delivered" && s.simulated),
      coverage: { score: cov.score, missing: cov.missing },
      dispute: d ? { id: d.id, status: d.status, reason: d.reason, simulated: d.simulated } : null,
      devFixture: isDevFixture(o.raw),
    };
  });
}

export type DisputeRow = {
  id: string;
  orderId: string | null;
  reason: string;
  reasonLabel: string;
  amountCents: number;
  currency: string;
  dueAt: string | null;
  status: string;
  stage: string;
  simulated: boolean;
  outcome: string | null;
  recommendation: Action | null;
  caseState: "none" | "built" | "submitted";
};

export async function listDisputeRows(db: Db): Promise<DisputeRow[]> {
  const ds = await db.select().from(disputes).orderBy(desc(disputes.lastEventAt));
  if (ds.length === 0) return [];
  const cs = await db
    .select({ disputeId: cases.disputeId, recommendation: cases.recommendation, draft: cases.draft, submittedAt: cases.submittedAt })
    .from(cases)
    .where(inArray(cases.disputeId, ds.map((d) => d.id)));
  return ds.map((d) => {
    const c = cs.find((x) => x.disputeId === d.id);
    const rec = (c?.recommendation ?? null) as StoredRecommendation | null;
    return {
      id: d.id,
      orderId: d.orderId,
      reason: d.reason,
      reasonLabel: reasonLabel(d.reason),
      amountCents: d.amountCents,
      currency: d.currency,
      dueAt: d.sellerResponseDue?.toISOString() ?? null,
      status: d.status,
      stage: d.stage,
      simulated: d.simulated,
      outcome: d.outcome,
      recommendation: rec?.action ?? null,
      caseState: c?.submittedAt ? "submitted" : c?.draft ? "built" : "none",
    };
  });
}

/** Everything the order page shows, or null for an unknown order. */
export async function getOrderDetail(db: Db, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [check] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, orderId));
  const ships = await db.select().from(shipments).where(eq(shipments.orderId, orderId));
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(order.mandateId ? or(eq(mandates.id, order.mandateId), eq(mandates.orderId, orderId)) : eq(mandates.orderId, orderId));
  const ds = await db.select().from(disputes).where(eq(disputes.orderId, orderId));
  return {
    order,
    result: (check?.result ?? null) as ProtectionResult | null,
    checkedAt: check?.checkedAt ?? null,
    shipments: ships,
    mandate: mandate ?? null,
    disputes: ds,
  };
}

/** The dispute and its case (without the PDF bytes), or null for an unknown dispute. */
export async function getDisputeDetail(db: Db, disputeId: string) {
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  if (!dispute) return null;
  const [c] = await db
    .select({
      id: cases.id,
      recommendation: cases.recommendation,
      draft: cases.draft,
      submittedAt: cases.submittedAt,
      submitResult: cases.submitResult,
      usedFallback: cases.usedFallback,
      builtAt: cases.builtAt,
    })
    .from(cases)
    .where(eq(cases.disputeId, disputeId));
  const [order] = dispute.orderId ? await db.select().from(orders).where(eq(orders.id, dispute.orderId)) : [];
  return { dispute, caseRow: c ?? null, order: order ?? null };
}

export async function countOpenDisputes(db: Db): Promise<number> {
  const rows = await db.select({ status: disputes.status }).from(disputes);
  return rows.filter((r) => isOpenDispute(r.status)).length;
}
