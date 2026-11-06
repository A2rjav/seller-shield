import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";
import { addTracking as paypalAddTracking, type AddTrackingInput } from "@/lib/paypal/tracking";
import type { Address } from "@/lib/paypal/types";

export type ShipmentRow = typeof shipments.$inferSelect;

export type ShipmentErrorCode = "not_found" | "invalid" | "no_capture" | "paypal_failed";

export class ShipmentError extends Error {
  constructor(public code: ShipmentErrorCode, message: string) {
    super(message);
  }
}

/** Orders inserted by `npm run dev:fixtures` carry `raw.devFixture`; they never existed at PayPal. */
export function isDevFixture(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { devFixture?: unknown }).devFixture === true;
}

async function loadOrder(db: Db, orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new ShipmentError("not_found", `Order ${orderId} not found`);
  return o;
}

async function loadShipment(db: Db, shipmentId: string) {
  const [s] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!s) throw new ShipmentError("not_found", `Shipment ${shipmentId} not found`);
  return s;
}

/** Records a shipment. The ship-to address defaults to the shipping address on the PayPal transaction. */
export async function addShipment(
  db: Db,
  orderId: string,
  input: { carrier: string; trackingNumber: string; shipToAddress?: Address | null },
): Promise<ShipmentRow> {
  const carrier = input.carrier?.trim();
  const trackingNumber = input.trackingNumber?.trim();
  if (!carrier) throw new ShipmentError("invalid", "Carrier is required.");
  if (!trackingNumber) throw new ShipmentError("invalid", "Tracking number is required.");
  const order = await loadOrder(db, orderId);

  const [row] = await db
    .insert(shipments)
    .values({
      id: `shp_${crypto.randomUUID()}`,
      orderId,
      carrier,
      trackingNumber,
      shipToAddress: input.shipToAddress ?? (order.shipAddress as Address | null) ?? null,
      // The tracking number is the seller's own; nothing about it is simulated until a demo delivery is applied.
      simulated: false,
    })
    .returning();
  return row;
}

export type PushDeps = { addTracking?: (input: AddTrackingInput) => Promise<void>; now?: () => Date };
export type PushResult = { shipment: ShipmentRow; simulated: boolean; alreadyPushed: boolean };

/**
 * Sends the shipment's tracking number to PayPal (Orders v2 add-tracking) and marks it pushed.
 * Idempotent: an already pushed shipment is returned without another PayPal call. Local dev fixture orders
 * are never sent to PayPal; their push is recorded and reported as simulated.
 */
export async function pushTrackingToPaypal(db: Db, shipmentId: string, deps: PushDeps = {}): Promise<PushResult> {
  const s = await loadShipment(db, shipmentId);
  const order = await loadOrder(db, s.orderId);
  if (s.pushedToPaypal) return { shipment: s, simulated: isDevFixture(order.raw), alreadyPushed: true };

  const simulated = isDevFixture(order.raw);
  if (!simulated) {
    if (!order.captureId) throw new ShipmentError("no_capture", "This order has no PayPal capture, so PayPal cannot accept tracking for it.");
    const addTracking = deps.addTracking ?? paypalAddTracking;
    try {
      await addTracking({
        orderId: order.id,
        captureId: order.captureId,
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        notifyPayer: false,
      });
    } catch (err) {
      throw new ShipmentError("paypal_failed", `PayPal did not accept the tracking: ${err instanceof Error ? err.message : "error"}`);
    }
  }
  const [row] = await db
    .update(shipments)
    .set({ pushedToPaypal: true, pushedAt: (deps.now ?? (() => new Date()))() })
    .where(eq(shipments.id, s.id))
    .returning();
  return { shipment: row, simulated, alreadyPushed: false };
}

/** Demo carrier: marks the shipment delivered now. Always simulated (there is no real carrier feed). */
export async function markDeliveredSimulated(db: Db, shipmentId: string, now: Date = new Date()): Promise<ShipmentRow> {
  await loadShipment(db, shipmentId);
  const [row] = await db
    .update(shipments)
    .set({ status: "delivered", deliveredAt: now, simulated: true })
    .where(eq(shipments.id, shipmentId))
    .returning();
  return row;
}

/** The shipment the protection rules look at: a delivered one first, then a pushed one, then the newest. */
export function primaryShipment<T extends Pick<ShipmentRow, "status" | "pushedToPaypal">>(rows: T[]): T | null {
  return rows.find((r) => r.status === "delivered") ?? rows.find((r) => r.pushedToPaypal) ?? rows[rows.length - 1] ?? null;
}
