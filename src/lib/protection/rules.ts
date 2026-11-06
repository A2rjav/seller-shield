import type { Address } from "@/lib/paypal/types";

/*
 * POLICY SOURCE (not verified against live text): PayPal US User Agreement, "Seller Protection" section
 * https://www.paypal.com/us/legalhub/paypal/useragreement-full
 * The fetch of that page was blocked (HTTP 403 bot challenge) when this was written, so the rule
 * descriptions below come from the project research notes and MUST be verified against the current
 * policy text before submission.
 */

/*
 * Section: User Agreement > Seller Protection > "Eligibility requirements" (signature confirmation for
 * high-value items). https://www.paypal.com/us/legalhub/paypal/useragreement-full
 * The $750 figure is from the research notes; verify against the current policy text.
 */
export const SIGNATURE_THRESHOLD_CENTS = 75000;

export type GapCode =
  | "address_mismatch"
  | "no_tracking"
  | "tracking_not_on_paypal"
  | "signature_required_over_threshold"
  | "non_physical_item"
  | "agent_mandate_missing_or_failed";

export type Gap = {
  code: GapCode;
  severity: "high" | "medium";
  fix: "push_tracking" | "require_signature" | "ship_to_paypal_address" | null;
};

export type ProtectionResult = { status: "protected" | "at_risk" | "not_eligible"; gaps: Gap[] };

export type ProtectionInput = {
  amountCents: number;
  currency: string;
  paypalShipAddress: Address | null;
  shipToAddress: Address | null;
  items: { kind: "physical" | "service" | "digital" }[];
  shipment: { trackingNumber?: string; pushedToPaypal: boolean; signatureRequired: boolean; status?: string } | null;
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

  // User Agreement > Seller Protection > "Eligibility requirements": item must be a tangible, physical good.
  // https://www.paypal.com/us/legalhub/paypal/useragreement-full (verify wording; see header note)
  const nonPhysical = o.items.some((i) => i.kind === "service" || i.kind === "digital");
  if (nonPhysical) gaps.push({ code: "non_physical_item", severity: "high", fix: null });

  // User Agreement > Seller Protection > "Eligibility requirements": ship to the address on the PayPal
  // transaction details. https://www.paypal.com/us/legalhub/paypal/useragreement-full
  // Both exist and differ -> high. PayPal address missing -> medium (we cannot confirm a match).
  // Our ship-to missing while PayPal has one is not flagged here (the no_tracking gap covers unshipped orders).
  if (!o.paypalShipAddress) {
    gaps.push({ code: "address_mismatch", severity: "medium", fix: null });
  } else if (o.shipToAddress && !addressesMatch(o.paypalShipAddress, o.shipToAddress)) {
    gaps.push({ code: "address_mismatch", severity: "high", fix: "ship_to_paypal_address" });
  }

  const tracking = o.shipment?.trackingNumber?.trim();
  if (!o.shipment || !tracking) {
    // User Agreement > Seller Protection > "Proof of shipment / delivery": need online tracking. The seller must ship first.
    // https://www.paypal.com/us/legalhub/paypal/useragreement-full
    gaps.push({ code: "no_tracking", severity: "high", fix: null });
  } else if (!o.shipment.pushedToPaypal) {
    // User Agreement > Seller Protection > "Proof of shipment / delivery": tracking must be uploaded to the PayPal transaction.
    // https://www.paypal.com/us/legalhub/paypal/useragreement-full
    gaps.push({ code: "tracking_not_on_paypal", severity: "high", fix: "push_tracking" });
  }

  // User Agreement > Seller Protection > signature confirmation for orders at/over the threshold.
  // https://www.paypal.com/us/legalhub/paypal/useragreement-full (see SIGNATURE_THRESHOLD_CENTS)
  if (o.amountCents >= SIGNATURE_THRESHOLD_CENTS && !o.shipment?.signatureRequired) {
    gaps.push({ code: "signature_required_over_threshold", severity: "high", fix: "require_signature" });
  }

  // Project rule (not a PayPal policy item): an AI-agent purchase needs a verified buyer mandate as proof of authorisation.
  if (o.source === "agent" && o.mandateVerified !== true) {
    gaps.push({ code: "agent_mandate_missing_or_failed", severity: "high", fix: null });
  }

  const status = nonPhysical ? "not_eligible" : gaps.length > 0 ? "at_risk" : "protected";
  return { status, gaps };
}
