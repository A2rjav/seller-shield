import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mandates, orders } from "@/lib/db/schema";
import { getOrder, captureOrder } from "@/lib/paypal/orders";
import { toCents } from "@/lib/money";
import { recordCapturedOrder, type OrderItem } from "./record";

type PpOrder = {
  purchase_units?: { items?: { name?: string; sku?: string; quantity?: string; unit_amount?: { value?: string } }[] }[];
};

function itemsFromPaypal(order: unknown): OrderItem[] {
  const list = (order as PpOrder).purchase_units?.[0]?.items ?? [];
  return list.map((i) => ({
    sku: i.sku ?? "",
    name: i.name ?? i.sku ?? "Item",
    qty: Number.parseInt(i.quantity ?? "1", 10) || 1,
    priceCents: toCents(i.unit_amount?.value ?? "0"),
  }));
}

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
  const items = itemsFromPaypal(await deps.getOrder(id));
  const captured = await deps.captureOrder(id);
  await recordCapturedOrder(db, {
    ...captured,
    orderId: id,
    source: mandate ? "agent" : "human",
    mandateId: mandate?.id,
    items,
  });
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}
