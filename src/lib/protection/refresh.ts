import { eq, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mandates, orders, protectionChecks, shipments } from "@/lib/db/schema";
import { getProduct } from "@/lib/catalog";
import type { Address } from "@/lib/paypal/types";
import { primaryShipment } from "@/lib/shipments/service";
import { explainGaps as defaultExplain, type ExplainOrder, type ExplainResult, type FallbackReason } from "./explain";
import { evaluateProtection, type ProtectionInput, type ProtectionResult } from "./rules";

/** Stored in `protection_checks.explanation`. `gapKey` ties the lines to the gap set they explain. */
export type StoredExplanation = {
  gapKey: string;
  lines: ExplainResult["lines"];
  usedFallback: boolean;
  fallbackReason?: FallbackReason;
  explainedAt: string;
};

export type OrderExplanation = Omit<StoredExplanation, "gapKey" | "explainedAt"> & { cached: boolean };

/** A standard-text explanation is retried after this long (an AI explanation is kept while the gaps are unchanged). */
export const FALLBACK_RETRY_MS = 10 * 60_000;

export function gapKey(result: ProtectionResult): string {
  return result.gaps.map((g) => g.code).sort().join(",");
}

/** Rebuilds the rule input from the stored order, its shipment and its mandate. Null when the order is unknown. */
export async function loadProtectionInput(
  db: Db,
  orderId: string,
): Promise<{ input: ProtectionInput; explainOrder: ExplainOrder } | null> {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return null;

  const ship = primaryShipment(await db.select().from(shipments).where(eq(shipments.orderId, orderId)));

  let mandateVerified: boolean | null = null;
  if (o.source === "agent") {
    const [m] = await db
      .select({ verified: mandates.verified })
      .from(mandates)
      .where(o.mandateId ? or(eq(mandates.id, o.mandateId), eq(mandates.orderId, o.id)) : eq(mandates.orderId, o.id));
    mandateVerified = m ? m.verified : o.mandateId ? false : null;
  }

  const items = Array.isArray(o.items) ? (o.items as { sku?: string }[]) : [];
  const paypalShipAddress = (o.shipAddress ?? null) as Address | null;
  const shipToAddress = (ship?.shipToAddress ?? null) as Address | null;
  const input: ProtectionInput = {
    amountCents: o.amountCents,
    currency: o.currency,
    paypalShipAddress,
    shipToAddress,
    items: items.map((i) => ({ kind: (typeof i.sku === "string" ? getProduct(i.sku)?.kind : undefined) ?? "physical" })),
    shipment: ship ? { trackingNumber: ship.trackingNumber, pushedToPaypal: ship.pushedToPaypal, status: ship.status } : null,
    source: o.source,
    mandateVerified,
  };
  return { input, explainOrder: { amountCents: o.amountCents, currency: o.currency, paypalShipAddress, shipToAddress } };
}

/**
 * Re-evaluates Seller Protection for an order from its current rows and stores it. The cached AI
 * explanation is cleared when the set of gaps changes. Returns null for an unknown order.
 */
export async function recomputeProtection(db: Db, orderId: string, now: Date = new Date()): Promise<ProtectionResult | null> {
  const loaded = await loadProtectionInput(db, orderId);
  if (!loaded) return null;
  const result = evaluateProtection(loaded.input);

  const [existing] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, orderId));
  const keep = existing && gapKey(existing.result as ProtectionResult) === gapKey(result);
  const explanation = keep ? existing.explanation : null;
  await db
    .insert(protectionChecks)
    .values({ orderId, result, explanation, checkedAt: now })
    .onConflictDoUpdate({ target: protectionChecks.orderId, set: { result, explanation, checkedAt: now } });
  return result;
}

export type ExplainDeps = { explain?: typeof defaultExplain; now?: () => Date };

/**
 * Plain-language lines for the order's current gaps: one AI call, then cached in `protection_checks.explanation`
 * while the gap set is unchanged. Standard (fallback) text is retried after FALLBACK_RETRY_MS.
 * Null when the order has no protection check yet.
 */
export async function getOrderExplanation(db: Db, orderId: string, deps: ExplainDeps = {}): Promise<OrderExplanation | null> {
  const now = (deps.now ?? (() => new Date()))();
  const [check] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, orderId));
  if (!check) return null;
  const result = check.result as ProtectionResult;
  if (result.gaps.length === 0) return { lines: [], usedFallback: false, cached: false };

  const key = gapKey(result);
  const stored = check.explanation as StoredExplanation | null;
  if (stored && stored.gapKey === key) {
    const fresh = !stored.usedFallback || now.getTime() - new Date(stored.explainedAt).getTime() < FALLBACK_RETRY_MS;
    if (fresh) return { lines: stored.lines, usedFallback: stored.usedFallback, fallbackReason: stored.fallbackReason, cached: true };
  }

  const loaded = await loadProtectionInput(db, orderId);
  if (!loaded) return null;
  const r = await (deps.explain ?? defaultExplain)(result, loaded.explainOrder);
  const next: StoredExplanation = {
    gapKey: key,
    lines: r.lines,
    usedFallback: r.usedFallback,
    ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}),
    explainedAt: now.toISOString(),
  };
  await db.update(protectionChecks).set({ explanation: next }).where(eq(protectionChecks.orderId, orderId));
  return { lines: next.lines, usedFallback: next.usedFallback, fallbackReason: next.fallbackReason, cached: false };
}
