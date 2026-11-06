import { eq } from "drizzle-orm";
import { z } from "zod";
import { getProduct } from "@/lib/catalog";
import { schema, type Db } from "@/lib/db/client";
import { verifyMandate, type MandateFailure, type OrderRequest } from "@/lib/mandate/mandate";
import { createOrder as paypalCreateOrder } from "@/lib/paypal/orders";
import { getAgentKeys } from "./agent-keys";

const itemsSchema = z.array(z.object({ sku: z.string().min(1), qty: z.number().int().positive().max(20) })).min(1).max(10);
export type CheckoutItems = z.infer<typeof itemsSchema>;

export type CheckoutInput = { shopperJws: string; agentJws: string; items: unknown };
export type CheckoutDeps = {
  createOrder?: (input: { items: CheckoutItems; customId?: string; returnUrl: string; cancelUrl: string }) => Promise<{ id: string; approveUrl: string }>;
  agentPublicJwk?: JsonWebKey;
  now?: () => Date;
  baseUrl?: string;
};
export type CheckoutResult =
  | { status: 200; data: { orderId: string; approveUrl: string; hash: string; mandateId: string } }
  | { status: 409; data: { error: string } }
  | { status: 422; data: { error: string; failures: MandateFailure[] } }
  | { status: 502; data: { error: string } };

/** The exact order the agent must sign: prices come from the catalog. Null when an item is unknown or malformed. */
export function buildOrderRequest(items: unknown): OrderRequest | null {
  const parsed = itemsSchema.safeParse(items);
  if (!parsed.success) return null;
  let amountCents = 0;
  for (const i of parsed.data) {
    const p = getProduct(i.sku);
    if (!p) return null;
    amountCents += p.priceCents * i.qty;
  }
  return { items: parsed.data, amountCents, currency: "USD" };
}

/**
 * Merchant side of agent checkout. Verifies the shopper mandate and the agent signature, claims the mandate
 * (single use) BEFORE touching PayPal, creates the order with the mandate hash as custom_id, then links the order.
 */
export async function agentCheckout(db: Db, input: CheckoutInput, deps: CheckoutDeps = {}): Promise<CheckoutResult> {
  const order = buildOrderRequest(input.items);
  if (!order || typeof input.shopperJws !== "string" || typeof input.agentJws !== "string") {
    return { status: 422, data: { error: "Mandate not accepted", failures: ["invalid_order"] } };
  }
  const agentPublicJwk = deps.agentPublicJwk ?? (await getAgentKeys()).publicJwk;
  const v = await verifyMandate({
    shopperJws: input.shopperJws,
    agentJws: input.agentJws,
    agentPublicJwk,
    order,
    now: (deps.now ?? (() => new Date()))(),
  });
  if (!v.verified || !v.payload || !v.hash) {
    return { status: 422, data: { error: "Mandate not accepted", failures: v.failures } };
  }
  const { payload, hash } = v;
  const { mandates } = schema;

  const claimed = await db
    .insert(mandates)
    .values({ id: payload.mandateId, orderId: null, payload, shopperJws: input.shopperJws, agentJws: input.agentJws, hash, verified: true, failures: [] })
    .onConflictDoNothing()
    .returning({ id: mandates.id });
  if (claimed.length === 0) return { status: 409, data: { error: "mandate already used" } };

  const release = () => db.delete(mandates).where(eq(mandates.id, payload.mandateId)).catch(() => {});
  try {
    const base = (deps.baseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const created = await (deps.createOrder ?? paypalCreateOrder)({
      items: order.items,
      customId: hash,
      returnUrl: `${base}/`,
      cancelUrl: `${base}/`,
    });
    try {
      await db.update(mandates).set({ orderId: created.id }).where(eq(mandates.id, payload.mandateId));
    } catch (e) {
      await release();
      throw e;
    }
    return { status: 200, data: { orderId: created.id, approveUrl: created.approveUrl, hash, mandateId: payload.mandateId } };
  } catch (err) {
    await release();
    console.error("Agent checkout failed", err instanceof Error ? err.message : "error");
    return { status: 502, data: { error: "Could not start checkout" } };
  }
}
