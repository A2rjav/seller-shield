import { paypalFetch, type PaypalClient } from "./client";

export type AddTrackingInput = {
  orderId: string;
  captureId: string;
  carrier: string;
  trackingNumber: string;
  notifyPayer: boolean;
};

export function createTrackingApi(client: Pick<PaypalClient, "paypalFetch">) {
  /** Orders v2 add-tracking. Mutating, so it carries a PayPal-Request-Id (derived, so a double click is idempotent). */
  async function addTracking(input: AddTrackingInput): Promise<void> {
    await client.paypalFetch<unknown>(`/v2/checkout/orders/${encodeURIComponent(input.orderId)}/track`, {
      method: "POST",
      requestId: `track-${input.orderId}-${input.captureId}-${input.trackingNumber}`,
      body: {
        capture_id: input.captureId,
        tracking_number: input.trackingNumber,
        carrier: input.carrier,
        notify_payer: input.notifyPayer,
      },
    });
  }
  return { addTracking };
}

const api = createTrackingApi({ paypalFetch });
export const addTracking = api.addTracking;
