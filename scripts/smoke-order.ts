// Live sandbox smoke check: creates one order and prints its id and approve URL.
// Run: npx tsx scripts/smoke-order.ts   (needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env)
import "dotenv/config";
import { createOrder } from "../src/lib/paypal/orders";
import { PaypalError } from "../src/lib/paypal/client";

async function main() {
  const order = await createOrder({
    items: [{ sku: "silver-hoops", qty: 1 }],
    customId: `smoke-${Date.now()}`,
    returnUrl: "http://localhost:3000/checkout/return",
    cancelUrl: "http://localhost:3000/checkout/cancel",
  });
  console.log("order id:", order.id);
  console.log("created (HTTP 2xx)");
  console.log("approve url:", order.approveUrl);
}

main().catch((e) => {
  // Never print config or credentials; only the PayPal error summary.
  if (e instanceof PaypalError) console.error(`PayPal error ${e.status} ${e.name}: ${e.message} (debug_id ${e.debugId})`);
  else console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
