import { getEnv } from "@/lib/env";
import { createOrder } from "@/lib/paypal/orders";
import { createOrderBody } from "@/lib/orders/create-schema";

export const dynamic = "force-dynamic";

/** Creates a PayPal sandbox order for the JS SDK; prices come from the catalog, never the client. */
export async function POST(req: Request): Promise<Response> {
  const parsed = createOrderBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid cart" }, { status: 400 });
  try {
    const base = getEnv().APP_BASE_URL.replace(/\/$/, "");
    const { id } = await createOrder({ items: parsed.data.items, returnUrl: `${base}/`, cancelUrl: `${base}/` });
    return Response.json({ id });
  } catch (err) {
    console.error("Create order failed", err instanceof Error ? err.message : "error");
    return Response.json({ error: "Could not start checkout" }, { status: 502 });
  }
}
