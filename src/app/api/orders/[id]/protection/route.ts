import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { protectionChecks } from "@/lib/db/schema";
import { getOrderExplanation, recomputeProtection } from "@/lib/protection/refresh";

export const dynamic = "force-dynamic";

/**
 * The order's Seller Protection result plus plain-language lines for its gaps. The lines come from one AI
 * call that is cached while the gaps are unchanged; past the daily AI cap standard text is returned.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    let [check] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, id));
    if (!check) {
      if (!(await recomputeProtection(db, id))) return Response.json({ error: "Order not found" }, { status: 404 });
      [check] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, id));
    }
    const explanation = await getOrderExplanation(db, id);
    return Response.json({ result: check.result, checkedAt: check.checkedAt, explanation });
  } catch (err) {
    console.error("Protection read failed", id, err instanceof Error ? err.message : "error");
    return Response.json({ error: "Could not load protection" }, { status: 500 });
  }
}
