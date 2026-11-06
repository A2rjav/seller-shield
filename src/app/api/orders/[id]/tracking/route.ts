import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";
import { recomputeProtection } from "@/lib/protection/refresh";
import { CARRIERS, TRACKING_NUMBER_RE, TRACKING_RULE_TEXT } from "@/lib/shipments/carriers";
import { addShipment, primaryShipment, pushTrackingToPaypal, ShipmentError } from "@/lib/shipments/service";

export const dynamic = "force-dynamic";

const body = z.union([
  z.object({ push: z.literal(true) }).strict(),
  z.object({ carrier: z.enum(CARRIERS), trackingNumber: z.string().trim().regex(TRACKING_NUMBER_RE) }).strict(),
]);

const STATUS: Record<ShipmentError["code"], number> = {
  not_found: 404,
  invalid: 400,
  no_capture: 409,
  paypal_failed: 502,
  already_pushed: 409,
};

/**
 * One-click fix. `{ carrier, trackingNumber }` records the order's shipment (replacing an unpushed one, so a
 * wrong number can be corrected) and pushes it to PayPal; `{ push: true }` pushes the existing shipment.
 * Carrier must be USPS, UPS, FEDEX or DHL; the number 8-40 letters or digits. If PayPal refuses, the shipment
 * stays unpushed and can be corrected. Protection is re-evaluated after every change.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: `Send { carrier, trackingNumber } or { push: true }. ${TRACKING_RULE_TEXT}` }, { status: 400 });

  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id));
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  try {
    let shipmentId: string;
    if ("push" in parsed.data) {
      const s = primaryShipment(await db.select().from(shipments).where(eq(shipments.orderId, id)));
      if (!s) return Response.json({ error: "This order has no tracking yet. Add a tracking number first." }, { status: 409 });
      shipmentId = s.id;
    } else {
      shipmentId = (await addShipment(db, id, parsed.data)).id;
    }
    const pushed = await pushTrackingToPaypal(db, shipmentId);
    const result = await recomputeProtection(db, id);
    return Response.json({ result, shipment: pushed.shipment, simulated: pushed.simulated, alreadyPushed: pushed.alreadyPushed });
  } catch (err) {
    if (err instanceof ShipmentError) {
      const result = await recomputeProtection(db, id);
      const hint = err.code === "paypal_failed" ? " The tracking is saved but not on PayPal; correct it and try again." : "";
      return Response.json({ error: `${err.message}${hint}`, code: err.code, result }, { status: STATUS[err.code] });
    }
    console.error("Tracking fix failed", id, err instanceof Error ? err.message : "error");
    return Response.json({ error: "Could not update tracking. Try again." }, { status: 500 });
  }
}
