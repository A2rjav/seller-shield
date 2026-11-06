import { getWebhookId } from "@/lib/env";
import { paypalFetch, type PaypalClient } from "./client";

type Deps = { client: Pick<PaypalClient, "paypalFetch">; webhookId: () => string | undefined };

const HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export function createWebhookApi(deps: Deps) {
  /**
   * Verifies a webhook with PayPal's verify-webhook-signature endpoint. Fails closed:
   * missing webhook id, missing headers, unparsable body or any PayPal error -> false.
   */
  async function verifyWebhook(headers: Headers, body: string): Promise<boolean> {
    const webhookId = deps.webhookId();
    if (!webhookId) {
      console.error("PAYPAL_WEBHOOK_ID is not set; rejecting webhook (register one with scripts/register-webhook.ts)");
      return false;
    }
    const sig: Record<string, string> = {};
    for (const [field, header] of Object.entries(HEADERS)) {
      const v = headers.get(header);
      if (!v) return false;
      sig[field] = v;
    }
    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return false;
    }
    try {
      const res = await deps.client.paypalFetch<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: { ...sig, webhook_id: webhookId, webhook_event: event },
      });
      return res?.verification_status === "SUCCESS";
    } catch (err) {
      console.error("Webhook verification call failed", err instanceof Error ? err.name : "error");
      return false;
    }
  }
  return { verifyWebhook };
}

const api = createWebhookApi({ client: { paypalFetch }, webhookId: () => getWebhookId() });
export const verifyWebhook = api.verifyWebhook;
