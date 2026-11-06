import { z } from "zod";
import { db } from "@/lib/db/client";
import { demoErrorResponse } from "@/lib/demo/http";
import { createSimulatedDispute, SIM_REASONS } from "@/lib/demo/simulate";

export const dynamic = "force-dynamic";

const body = z.object({ orderId: z.string().trim().min(1).max(64), reason: z.enum(SIM_REASONS) }).strict();

/** Opens a SIMULATED dispute on an order (nothing is sent to PayPal). One open simulated dispute per order. */
export async function POST(req: Request): Promise<Response> {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose an order and a reason." }, { status: 400 });
  try {
    const dispute = await createSimulatedDispute(db, parsed.data.orderId, parsed.data.reason);
    return Response.json({ dispute: { id: dispute.id, stage: dispute.stage, status: dispute.status }, simulated: true });
  } catch (e) {
    return demoErrorResponse(e, "Could not open the simulated dispute.");
  }
}
