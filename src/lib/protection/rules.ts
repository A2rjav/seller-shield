import type { Address } from "@/lib/paypal/types";

/*
 * POLICY SOURCE: PayPal US Seller Protection policy, last updated 2026-01-26,
 * https://www.paypal.com/us/legalhub/paypal/seller-protection
 * Verified excerpt: D:\Hackathons\Paypal\research\paypal-us-seller-protection-2026-01-26.md
 * The current policy has no signature-confirmation rule and no $750 threshold.
 */

/*
 * Section: "Transaction cap" - covered transactions are $10,000.00 USD or below, unless the buyer claims
 * Unauthorized Transaction and all other requirements are met.
 * https://www.paypal.com/us/legalhub/paypal/seller-protection
 */
export const PROTECTION_CAP_CENTS = 1_000_000;

export type GapCode =
  | "address_mismatch"
  | "no_tracking"
  | "tracking_not_on_paypal"
  | "no_delivery_confirmation"
  | "over_protection_cap"
  | "intangible_needs_proof"
  | "agent_mandate_missing_or_failed";

export type Gap = {
  code: GapCode;
  severity: "high" | "medium";
  fix: "push_tracking" | "ship_to_paypal_address" | null;
  /** paypal_policy: a stated PayPal requirement. seller_shield: our best-practice rule. */
  basis: "paypal_policy" | "seller_shield";
};

export type ProtectionResult = { status: "protected" | "pending" | "at_risk" | "not_eligible"; gaps: Gap[] };

export type ProtectionInput = {
  amountCents: number;
  currency: string;
  paypalShipAddress: Address | null;
  shipToAddress: Address | null;
  items: { kind: "physical" | "service" | "digital" }[];
  shipment: { trackingNumber?: string; pushedToPaypal: boolean; status?: string } | null;
  source: "human" | "agent";
  mandateVerified: boolean | null;
};

function norm(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:#]+$/g, "").trim();
}

/** Case, whitespace and trailing punctuation are ignored; US ZIP compared on its first 5 characters. */
export function addressesMatch(a: Address, b: Address): boolean {
  const zip = (x: Address) => (norm(x.countryCode) === "us" ? norm(x.postalCode).slice(0, 5) : norm(x.postalCode));
  return (
    norm(a.line1) === norm(b.line1) &&
    norm(a.line2) === norm(b.line2) &&
    norm(a.city) === norm(b.city) &&
    norm(a.state) === norm(b.state) &&
    zip(a) === zip(b) &&
    norm(a.countryCode) === norm(b.countryCode)
  );
}

export function evaluateProtection(o: ProtectionInput): ProtectionResult {
  const gaps: Gap[] = [];

  // Section: "Transaction cap" ($10,000.00 USD). https://www.paypal.com/us/legalhub/paypal/seller-protection
  const overCap = o.amountCents > PROTECTION_CAP_CENTS;
  if (overCap) gaps.push({ code: "over_protection_cap", severity: "high", fix: null, basis: "paypal_policy" });

  // Section: "Intangible Goods Additional Requirements" - services and digital goods can be covered only with
  // compelling evidence of delivery. https://www.paypal.com/us/legalhub/paypal/seller-protection
  if (o.items.some((i) => i.kind === "service" || i.kind === "digital")) {
    gaps.push({ code: "intangible_needs_proof", severity: "medium", fix: null, basis: "paypal_policy" });
  }

  // Section: "Eligibility requirements" - ship to the address on the Transaction Details page.
  // https://www.paypal.com/us/legalhub/paypal/seller-protection
  // Both exist and differ -> high. PayPal address missing -> medium (cannot confirm a match). Our ship-to missing
  // while PayPal has one is not flagged here (no_tracking covers unshipped orders).
  if (!o.paypalShipAddress) {
    gaps.push({ code: "address_mismatch", severity: "medium", fix: null, basis: "paypal_policy" });
  } else if (o.shipToAddress && !addressesMatch(o.paypalShipAddress, o.shipToAddress)) {
    gaps.push({ code: "address_mismatch", severity: "high", fix: "ship_to_paypal_address", basis: "paypal_policy" });
  }

  const tracking = o.shipment?.trackingNumber?.trim();
  if (!o.shipment || !tracking) {
    // Section: "Proof of shipment or delivery" - online, verifiable tracking number. The seller must ship first.
    // https://www.paypal.com/us/legalhub/paypal/seller-protection
    gaps.push({ code: "no_tracking", severity: "high", fix: null, basis: "paypal_policy" });
  } else {
    // Seller Shield best practice (not a stated PayPal rule): put proof of shipment where PayPal can see it.
    if (!o.shipment.pushedToPaypal) {
      gaps.push({ code: "tracking_not_on_paypal", severity: "medium", fix: "push_tracking", basis: "seller_shield" });
    }
    // Section: "Item Not Received Additional Requirement" - proof of delivery needs the date of delivery and
    // 'delivered' status. https://www.paypal.com/us/legalhub/paypal/seller-protection
    if (o.shipment.status?.toLowerCase() !== "delivered") {
      gaps.push({ code: "no_delivery_confirmation", severity: "medium", fix: null, basis: "paypal_policy" });
    }
  }

  // Seller Shield rule (not a PayPal policy item): an AI-agent purchase needs a verified buyer mandate
  // as proof the purchase was authorised.
  if (o.source === "agent" && o.mandateVerified !== true) {
    gaps.push({ code: "agent_mandate_missing_or_failed", severity: "high", fix: null, basis: "seller_shield" });
  }

  const status = overCap
    ? "not_eligible"
    : gaps.some((g) => g.severity === "high")
      ? "at_risk"
      : gaps.length > 0
        ? "pending"
        : "protected";
  return { status, gaps };
}
