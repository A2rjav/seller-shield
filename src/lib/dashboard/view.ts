import { formatMoney } from "@/lib/format";
import type { Gap, GapCode, ProtectionResult } from "@/lib/protection/rules";

export { isCoveredBySellerProtection, SELLER_PROTECTION_COVERED_REASONS } from "@/lib/protection/covered";

/** Status colours always come with a text label; tone picks the colour, never the meaning. */
export type Tone = "green" | "amber" | "red" | "gray" | "blue";
export type Badge = { label: string; tone: Tone };

export function protectionBadge(status: ProtectionResult["status"] | null | undefined): Badge {
  switch (status) {
    case "protected":
      return { label: "Protected", tone: "green" };
    case "pending":
      return { label: "Pending", tone: "amber" };
    case "at_risk":
      return { label: "At risk", tone: "red" };
    case "not_eligible":
      return { label: "Not eligible", tone: "gray" };
    default:
      return { label: "Not checked", tone: "gray" };
  }
}

export type MandateState = "verified" | "failed" | "not_checked";

export function mandateStateOf(m: { verified: boolean } | null | undefined): MandateState {
  if (!m) return "not_checked";
  return m.verified ? "verified" : "failed";
}

export function mandateBadge(state: MandateState): Badge {
  if (state === "verified") return { label: "Mandate verified", tone: "green" };
  if (state === "failed") return { label: "Mandate failed", tone: "red" };
  return { label: "Mandate not checked", tone: "gray" };
}

export const GAP_TITLE: Record<GapCode, string> = {
  address_mismatch: "Ship-to address differs from PayPal",
  no_tracking: "No tracking yet",
  tracking_not_on_paypal: "Tracking not on PayPal",
  no_delivery_confirmation: "Not confirmed delivered",
  over_protection_cap: "Over the $10,000 protection cap",
  intangible_needs_proof: "Intangible item needs proof",
  agent_mandate_missing_or_failed: "Agent mandate missing or failed",
};

export function basisLabel(basis: Gap["basis"]): string {
  return basis === "paypal_policy" ? "PayPal policy" : "Seller Shield tip";
}

const REASON_LABEL: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized payment",
  DUPLICATE_TRANSACTION: "Charged twice",
  INCORRECT_AMOUNT: "Wrong amount charged",
  CREDIT_NOT_PROCESSED: "Refund not received",
  OTHER: "Other",
};

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? "Other";
}

/** "Protected" copy is qualified when the delivery confirmation comes from the demo carrier. */
export function protectedText(text: string, deliverySimulated: boolean): string {
  return deliverySimulated ? `${text} (delivery Simulated)` : text;
}

/** PayPal accepts offers only before the chargeback stage; null when an offer is allowed. */
export function offerBlockedReason(stage: string | null | undefined): string | null {
  return stage?.toUpperCase() === "CHARGEBACK"
    ? "Offers are not possible at the chargeback stage: submit evidence or accept the claim."
    : null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function disputeStatusChip(status: string): Badge {
  switch (status.toUpperCase()) {
    case "WAITING_FOR_SELLER_RESPONSE":
      return { label: "Needs your response", tone: "red" };
    case "OPEN":
      return { label: "Open", tone: "red" };
    case "WAITING_FOR_BUYER_RESPONSE":
      return { label: "Waiting on buyer", tone: "blue" };
    case "UNDER_REVIEW":
      return { label: "PayPal reviewing", tone: "amber" };
    case "RESOLVED":
      return { label: "Resolved", tone: "gray" };
    default:
      return { label: titleCase(status), tone: "gray" };
  }
}

export const isOpenDispute = (status: string) => status.toUpperCase() !== "RESOLVED";

/** The case page for a dispute id; undefined for an empty id. */
export const disputeCaseHref = (id: string): string | undefined => (id.trim() ? `/dashboard/disputes/${encodeURIComponent(id.trim())}` : undefined);

export type Countdown = { label: string; urgency: "none" | "ok" | "soon" | "overdue" };

function span(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Seller response deadline as a countdown. Under 48 hours is "soon". */
export function dueCountdown(due: Date | string | null | undefined, now: Date): Countdown {
  if (!due) return { label: "No deadline", urgency: "none" };
  const t = new Date(due).getTime();
  if (Number.isNaN(t)) return { label: "No deadline", urgency: "none" };
  const left = t - now.getTime();
  if (left <= 0) return { label: `Overdue by ${span(-left)}`, urgency: "overdue" };
  return { label: `${span(left)} left`, urgency: left < 48 * 3_600_000 ? "soon" : "ok" };
}

/** EVs are estimates and can be fractional cents; shown rounded with the sign kept. */
export function formatEv(cents: number): string {
  const rounded = Math.round(cents);
  return rounded < 0 ? `-${formatMoney(-rounded)}` : formatMoney(rounded);
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;

export function evFormulaText(input: { winProbability: number; amountCents: number; feeCents: number; capped?: boolean }): string {
  const { winProbability: p, amountCents, feeCents } = input;
  return [
    "These are estimates, not PayPal outcomes.",
    `Win chance p = 0.15 + 0.7 x evidence coverage = ${percent(p)}.`,
    ...(input.capped ? ["Capped at 35% for claims Seller Protection does not cover."] : []),
    `Fight = p x ${formatMoney(amountCents)} - (1 - p) x ${formatMoney(feeCents)} PayPal dispute fee.`,
    `Offer = a 50% partial refund (assumes the buyer accepts). Refund = $0 kept.`,
  ].join(" ");
}

const MANDATE_FAILURE: Record<string, string> = {
  bad_shopper_signature: "The shopper's signature did not verify",
  bad_agent_signature: "The agent's request signature did not verify",
  expired: "The mandate had expired",
  amount_over_max: "The order was over the mandate's spending limit",
  item_not_in_mandate: "An item was not in the mandate",
  currency_mismatch: "The currency did not match the mandate",
  agent_not_named: "A different agent placed the order",
  malformed_mandate: "The mandate was unreadable",
  invalid_order: "The order itself was invalid",
  payer_email_mismatch: "The PayPal payer email did not match the shopper",
};

export function mandateFailureLabel(code: string): string {
  return MANDATE_FAILURE[code] ?? titleCase(code);
}

const SOURCE_LABEL: Record<string, string> = {
  paypal: "PayPal",
  storefront: "Storefront",
  seller_shield: "Seller Shield",
  demo_carrier: "Demo carrier",
  mandate: "Mandate",
};

export function evidenceSourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? titleCase(source);
}

const KIND_LABEL: Record<string, string> = {
  order: "Order record",
  capture: "Payment capture",
  ship_address: "PayPal ship-to address",
  tracking: "Tracking number",
  delivery: "Delivery confirmation",
  signature: "Signature",
  buyer_message: "Buyer messages",
  policy_at_checkout: "Store policy at checkout",
  mandate: "Signed purchase mandate",
  payer_approval: "PayPal payer approval",
  agent_identity: "Agent identity",
  refund: "Refund record",
  dispute: "Dispute record",
};

export function evidenceKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? titleCase(kind);
}

export const ACTION_LABEL = { fight: "Fight with evidence", offer: "Offer a partial refund", refund: "Accept and refund" } as const;
