import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mandates, orders } from "@/lib/db/schema";
import { getOrder, captureOrder, mapCapturedOrder, mapOrderItems, readCustomId } from "@/lib/paypal/orders";
import { PaypalError } from "@/lib/paypal/client";
import { recordCapturedOrder } from "./record";

/**
 * Captures a PayPal order once and records it. A second call returns the stored order without touching PayPal.
 * An order with a mandates row pointing at it is an agent order; otherwise it is a human order.
 */
export async function captureAndRecord(
  db: Db,
  id: string,
  deps = { getOrder, captureOrder },
): Promise<typeof orders.$inferSelect> {
  const [existing] = await db.select().from(orders).where(eq(orders.id, id));
  if (existing) return existing;

  const [mandate] = await db.select().from(mandates).where(eq(mandates.orderId, id));
  const ppOrder = await deps.getOrder(id);
  const items = mapOrderItems(ppOrder);
  let captured;
  try {
    captured = await deps.captureOrder(id);
  } catch (err) {
    // Money may already have moved (capture succeeded earlier but recording failed). Recover from PayPal's own record.
    const recovered = mapCapturedOrder(await deps.getOrder(id));
    if (!recovered) throw err;
    console.warn(`Recovered existing capture for order ${id} (${err instanceof PaypalError ? err.name : "capture error"})`);
    captured = recovered;
  }
  await recordCapturedOrder(db, {
    ...captured,
    orderId: id,
    source: mandate ? "agent" : "human",
    mandateId: mandate?.id,
    items,
  });
  if (mandate) {
    // The order was created with the mandate hash as custom_id: confirm PayPal's own record says the same.
    const match = readCustomId(ppOrder) === mandate.hash;
    await db.update(mandates).set({ paypalCustomIdMatch: match }).where(eq(mandates.id, mandate.id));
  }
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}
