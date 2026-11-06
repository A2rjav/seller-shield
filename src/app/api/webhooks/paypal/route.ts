import { db } from "@/lib/db/client";
import { handleWebhookEvent, type WebhookEvent } from "@/lib/disputes/ingest";
import { verifyWebhook } from "@/lib/paypal/webhooks";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Read the raw bytes first: the signature is checked against exactly what PayPal sent.
  const body = await req.text();
  if (!(await verifyWebhook(req.headers, body))) {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }
  let evt: WebhookEvent;
  try {
    evt = JSON.parse(body) as WebhookEvent;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  try {
    const result = await handleWebhookEvent(db, evt);
    return Response.json({ result });
  } catch (err) {
    console.error("Webhook processing failed", evt.event_type, err instanceof Error ? err.message : "error");
    // Non-2xx makes PayPal retry; the event was not recorded, so the retry is processed.
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}
