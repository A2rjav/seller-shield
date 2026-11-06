import { db } from "@/lib/db/client";
import { agentCheckout } from "@/lib/agent/checkout";

export const dynamic = "force-dynamic";

/** Merchant agent endpoint: body { shopperJws, agentJws, items }. */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { shopperJws?: unknown; agentJws?: unknown; items?: unknown } | null;
  if (!body || typeof body.shopperJws !== "string" || typeof body.agentJws !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const r = await agentCheckout(db, { shopperJws: body.shopperJws, agentJws: body.agentJws, items: body.items });
  return Response.json(r.data, { status: r.status });
}
