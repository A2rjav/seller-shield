import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { shipments } from "@/lib/db/schema";
import { recomputeProtection } from "@/lib/protection/refresh";
import { addShipment, primaryShipment, pushTrackingToPaypal, ShipmentError } from "@/lib/shipments/service";

export const dynamic = "force-dynamic";

const body = z.union([
  z.object({ push: z.literal(true) }),
  z.object({
    carrier: z.string().trim().min(1).max(40),
    trackingNumber: z.string().trim().min(4).max(64).regex(/^[A-Za-z0-9 -]+$/, "letters, digits, spaces and dashes only"),
  }),
]);

const STATUS: Record<ShipmentError["code"], number> = { not_found: 404, invalid: 400, no_capture: 409, paypal_failed: 502 };

/**
 * One-click fix. `{ carrier, trackingNumber }` records the shipment (if the order has none) and pushes it to
 * PayPal; `{ push: true }` pushes the existing shipment. Protection is re-evaluated after every change, also
 * when PayPal refuses the push (the recorded shipment still changes the gaps).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { carrier, trackingNumber } (4-64 letters/digits) or { push: true }." }, { status: 400 });
  }

  const existing = await db.select().from(shipments).where(eq(shipments.orderId, id));
  let shipmentId: string;
  try {
    if ("push" in parsed.data) {
      const s = primaryShipment(existing);
      if (!s) return Response.json({ error: "This order has no tracking yet. Add a tracking number first." }, { status: 409 });
      shipmentId = s.id;
    } else {
      if (existing.length > 0) {
        return Response.json({ error: "This order already has tracking. Push it to PayPal instead." }, { status: 409 });
      }
      shipmentId = (await addShipment(db, id, parsed.data)).id;
    }
    const pushed = await pushTrackingToPaypal(db, shipmentId);
    const result = await recomputeProtection(db, id);
    return Response.json({ result, shipment: pushed.shipment, simulated: pushed.simulated, alreadyPushed: pushed.alreadyPushed });
  } catch (err) {
    if (err instanceof ShipmentError) {
      const result = err.code === "not_found" ? null : await recomputeProtection(db, id);
      return Response.json({ error: err.message, code: err.code, result }, { status: STATUS[err.code] });
    }
    console.error("Tracking fix failed", id, err instanceof Error ? err.message : "error");
    return Response.json({ error: "Could not update tracking. Try again." }, { status: 500 });
  }
}
