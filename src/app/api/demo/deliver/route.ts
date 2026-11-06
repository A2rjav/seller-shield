import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { shipments } from "@/lib/db/schema";
import { recomputeProtection } from "@/lib/protection/refresh";
import { markDeliveredSimulated, primaryShipment } from "@/lib/shipments/service";

export const dynamic = "force-dynamic";

const body = z.object({ orderId: z.string().trim().min(1).max(64) });

/** Demo carrier: marks the order's shipment delivered. Simulated (the sandbox has no carrier feed) and labelled so. */
export async function POST(req: Request): Promise<Response> {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { orderId }." }, { status: 400 });
  const { orderId } = parsed.data;

  const s = primaryShipment(await db.select().from(shipments).where(eq(shipments.orderId, orderId)));
  if (!s) return Response.json({ error: "This order has no shipment yet. Add tracking first." }, { status: 409 });
  if (s.status === "delivered") {
    return Response.json({ result: await recomputeProtection(db, orderId), shipment: s, simulated: s.simulated, alreadyDelivered: true });
  }
  const shipment = await markDeliveredSimulated(db, s.id);
  const result = await recomputeProtection(db, orderId);
  return Response.json({ result, shipment, simulated: true });
}
