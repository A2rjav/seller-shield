/** Carriers the seller can pick; values are PayPal carrier codes. Shared by the API and the tracking form. */
export const CARRIERS = ["USPS", "UPS", "FEDEX", "DHL"] as const;
export type Carrier = (typeof CARRIERS)[number];

/** Trimmed, 8-40 letters or digits. */
export const TRACKING_NUMBER_RE = /^[A-Za-z0-9]{8,40}$/;

export const TRACKING_RULE_TEXT = "Use USPS, UPS, FedEx or DHL and a tracking number of 8-40 letters or digits (no spaces).";

export function isCarrier(v: unknown): v is Carrier {
  return typeof v === "string" && (CARRIERS as readonly string[]).includes(v);
}

/** Validated tracking input, or null. */
export function parseTracking(input: { carrier: unknown; trackingNumber: unknown }): { carrier: Carrier; trackingNumber: string } | null {
  if (!isCarrier(input.carrier) || typeof input.trackingNumber !== "string") return null;
  const trackingNumber = input.trackingNumber.trim();
  return TRACKING_NUMBER_RE.test(trackingNumber) ? { carrier: input.carrier, trackingNumber } : null;
}
