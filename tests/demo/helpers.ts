import type { Db } from "@/lib/db/client";
import { mandates } from "@/lib/db/schema";

export const ADDR = { address_line_1: "12 Fern St", admin_area_2: "Austin", admin_area_1: "TX", postal_code: "78701", country_code: "US" };

/** A PayPal GET /v2/checkout/orders/{id} body for a completed capture. */
export function ppOrder(id: string, value = "60.00", email = "buyer@example.com") {
  return {
    id,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: `PAYER-${id}` },
    purchase_units: [
      {
        shipping: { name: { full_name: "Test Buyer" }, address: ADDR },
        items: [{ name: "Silver hoops", sku: "silver-hoops", quantity: "1", unit_amount: { value } }],
        payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: { value, currency_code: "USD" } }] },
      },
    ],
  };
}

export function fakePaypal(values: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    getOrder: async (id: string) => {
      calls.push(`getOrder:${id}`);
      return ppOrder(id, values[id] ?? "60.00");
    },
    addTracking: async (i: { orderId: string }) => {
      calls.push(`addTracking:${i.orderId}`);
    },
  };
}

export async function insertMandate(db: Db, id: string, orderId: string, email = "buyer@example.com") {
  await db.insert(mandates).values({
    id,
    orderId,
    shopperJws: "x",
    agentJws: "x",
    hash: "h",
    verified: true,
    failures: [],
    payerEmailMatch: true,
    payload: { mandateId: id, shopperEmail: email, agentId: "a", merchantId: "m", items: [], maxAmountCents: 100000, currency: "USD", createdAt: "", expiresAt: "", shopperPublicJwk: {} },
  });
}
