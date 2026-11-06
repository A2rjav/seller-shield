import { z } from "zod";
import { db } from "@/lib/db/client";
import { demoErrorResponse } from "@/lib/demo/http";
import { resolveDispute } from "@/lib/demo/simulate";
import { adjudicate, getDispute } from "@/lib/paypal/disputes";

export const dynamic = "force-dynamic";

const body = z.object({ disputeId: z.string().trim().min(1).max(64), outcome: z.enum(["SELLER_FAVOR", "BUYER_FAVOR"]) }).strict();

/**
 * Resolves a dispute. A simulated one closes locally (labelled Simulated); a real sandbox one calls PayPal's
 * sandbox adjudicate, only when PayPal says it is in a state that allows it.
 */
export async function POST(req: Request): Promise<Response> {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { disputeId, outcome: SELLER_FAVOR | BUYER_FAVOR }." }, { status: 400 });
  try {
    return Response.json(await resolveDispute(db, parsed.data, { adjudicate, getDispute }));
  } catch (e) {
    return demoErrorResponse(e, "Could not resolve the dispute.");
  }
}
