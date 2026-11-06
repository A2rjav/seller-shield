// Usage: npx tsx scripts/register-webhook.ts https://your-app.example.com/api/webhooks/paypal
// Registers the sandbox webhook and prints its id. Put the id in .env as PAYPAL_WEBHOOK_ID.
import "dotenv/config";
import { paypalFetch } from "../src/lib/paypal/client";

const EVENT_TYPES = [
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "CHECKOUT.ORDER.APPROVED",
];

async function main() {
  const url = process.argv[2];
  if (!url || !/^https:\/\//.test(url)) {
    console.error("Usage: tsx scripts/register-webhook.ts https://<public-host>/api/webhooks/paypal");
    process.exit(1);
  }
  const res = await paypalFetch<{ id: string }>("/v1/notifications/webhooks", {
    method: "POST",
    body: { url, event_types: EVENT_TYPES.map((name) => ({ name })) },
  });
  console.log(`Webhook registered. PAYPAL_WEBHOOK_ID=${res.id}`);
}

main().catch((err) => {
  console.error("Registration failed:", err instanceof Error ? `${err.name}: ${err.message}` : "error");
  process.exit(1);
});
