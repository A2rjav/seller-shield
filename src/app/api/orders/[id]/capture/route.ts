import { db } from "@/lib/db/client";
import { captureAndRecord } from "@/lib/orders/capture";

export const dynamic = "force-dynamic";

/** Captures an approved PayPal order (human or agent) and records it with its Seller Protection check. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const o = await captureAndRecord(db, id);
    return Response.json({ id: o.id, status: o.status, source: o.source });
  } catch (err) {
    console.error("Capture failed", id, err instanceof Error ? err.message : "error");
    return Response.json({ error: "Payment could not be captured" }, { status: 502 });
  }
}
