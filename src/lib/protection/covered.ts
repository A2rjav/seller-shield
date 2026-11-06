// Client-safe: one list shared by the dashboard copy and the fight/offer/refund recommendation.

/** Dispute reasons PayPal US Seller Protection covers (item not received, unauthorised payment). Everything else is not covered. */
export const SELLER_PROTECTION_COVERED_REASONS = ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "UNAUTHORISED"] as const;

export function isCoveredBySellerProtection(reason: string): boolean {
  return (SELLER_PROTECTION_COVERED_REASONS as readonly string[]).includes(reason);
}
