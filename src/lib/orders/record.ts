import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mandates, orders, protectionChecks } from "@/lib/db/schema";
import { getProduct } from "@/lib/catalog";
import { checkPayerMatch, type MandatePayload } from "@/lib/mandate/mandate";
import type { CapturedOrder } from "@/lib/paypal/orders";
import { evaluateProtection } from "@/lib/protection/rules";

export type OrderItem = { sku: string; name: string; qty: number; priceCents: number };

export type RecordInput = CapturedOrder & {
  orderId: string;
  source: "human" | "agent";
  items: OrderItem[];
  mandateId?: string;
};

/**
 * Stores a captured order (idempotent on the PayPal order id), applies the payer-email check for agent
 * orders, then evaluates and stores Seller Protection. No AI call happens here.
 */
export async function recordCapturedOrder(db: Db, c: RecordInput): Promise<void> {
  const now = new Date();
  const values = {
    source: c.source,
    status: c.status ?? "COMPLETED",
    amountCents: c.amountCents,
    currency: c.currency,
    buyerEmail: c.payerEmail || null,
    payerId: c.payerId || null,
    shipName: c.shipName,
    shipAddress: c.shipAddress,
    items: c.items,
    captureId: c.captureId,
    mandateId: c.mandateId ?? null,
  };
  await db
    .insert(orders)
    .values({ id: c.orderId, ...values, approvedAt: now })
    .onConflictDoUpdate({ target: orders.id, set: values });

  let mandateVerified: boolean | null = null;
  if (c.mandateId) {
    const [m] = await db.select().from(mandates).where(eq(mandates.id, c.mandateId));
    if (m) {
      const match = checkPayerMatch(m.payload as MandatePayload, c.payerEmail);
      const failures = Array.isArray(m.failures) ? [...(m.failures as string[])] : [];
      let verified = m.verified;
      if (!match) {
        verified = false;
        if (!failures.includes("payer_email_mismatch")) failures.push("payer_email_mismatch");
      }
      await db
        .update(mandates)
        .set({ orderId: c.orderId, payerEmailMatch: match, verified, failures })
        .where(eq(mandates.id, m.id));
      mandateVerified = verified;
    } else {
      mandateVerified = false; // order claims a mandate we do not hold
    }
  }

  const result = evaluateProtection({
    amountCents: c.amountCents,
    currency: c.currency,
    paypalShipAddress: c.shipAddress,
    shipToAddress: null,
    items: c.items.map((i) => ({ kind: getProduct(i.sku)?.kind ?? "physical" })),
    shipment: null,
    source: c.source,
    mandateVerified,
  });
  await db
    .insert(protectionChecks)
    .values({ orderId: c.orderId, result, checkedAt: now })
    .onConflictDoUpdate({ target: protectionChecks.orderId, set: { result, checkedAt: now } });
}
