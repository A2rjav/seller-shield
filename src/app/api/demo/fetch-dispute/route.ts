import { db } from "@/lib/db/client";
import { fetchAndIngestDispute, fetchDisputeBody } from "@/lib/demo/fetch-dispute";
import { demoErrorResponse } from "@/lib/demo/http";
import { getDispute } from "@/lib/paypal/disputes";

export const dynamic = "force-dynamic";

/** Fetches a real sandbox dispute by its PayPal id (PP-R-... or PP-D-...) and stores it. Nothing is sent to PayPal. */
export async function POST(req: Request): Promise<Response> {
  const parsed = fetchDisputeBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste the dispute ID PayPal shows, like PP-R-ABC-12345678 or PP-D-12345." }, { status: 400 });
  try {
    return Response.json(await fetchAndIngestDispute(db, parsed.data.disputeId, { getDispute }));
  } catch (e) {
    return demoErrorResponse(e, "Could not fetch the dispute from PayPal.");
  }
}
