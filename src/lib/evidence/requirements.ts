import type { EvidenceItem, EvidenceKind } from "./folder";

export type PaypalReason =
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "DUPLICATE_TRANSACTION"
  | "INCORRECT_AMOUNT"
  | "CREDIT_NOT_PROCESSED"
  | "OTHER";

/**
 * `paypalEvidenceType` values come from the PayPal Customer Disputes v1 `evidence.evidence_type` enum.
 * `needed` is aligned with the US Seller Protection policy (verified 2026-01-26): proof of shipment or
 * delivery, to the address on the transaction.
 */
export const REASON_REQUIREMENTS: Record<PaypalReason, { plain: string; needed: EvidenceKind[]; paypalEvidenceType: string }> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: {
    plain: "The buyer says the order never arrived, so you need tracking that shows delivery to the address on the PayPal transaction.",
    needed: ["tracking", "delivery", "ship_address"],
    paypalEvidenceType: "PROOF_OF_FULFILLMENT",
  },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: {
    plain:
      "The buyer says the item is not as described; PayPal Seller Protection does not cover this, but your policy, messages and delivery record can still support your side.",
    needed: ["policy_at_checkout", "buyer_message", "delivery"],
    paypalEvidenceType: "ITEM_DESCRIPTION",
  },
  // For non-agent orders the mandate / payer_approval / agent_identity items are simply absent from the folder,
  // so those orders will show them as missing; they only apply to purchases made by an AI agent.
  UNAUTHORISED: {
    plain:
      "The buyer says they did not authorise the payment, so you need proof of who approved it (for agent purchases, the signed mandate and the payer's approval) and proof you shipped to the transaction address.",
    needed: ["mandate", "payer_approval", "agent_identity", "ship_address", "tracking"],
    paypalEvidenceType: "PROOF_OF_FULFILLMENT",
  },
  DUPLICATE_TRANSACTION: {
    plain: "The buyer says they were charged twice, so you need to show the two charges were for separate orders.",
    needed: ["order", "capture"],
    paypalEvidenceType: "DETAILS_OF_PURCHASE",
  },
  INCORRECT_AMOUNT: {
    plain: "The buyer says the amount charged is wrong, so you need the order record showing what was bought and charged.",
    needed: ["order", "capture"],
    paypalEvidenceType: "DETAILS_OF_PURCHASE",
  },
  CREDIT_NOT_PROCESSED: {
    plain: "The buyer says an expected refund has not arrived, so you need a record of the refund or of the return policy.",
    needed: ["refund", "policy_at_checkout"],
    paypalEvidenceType: "PROOF_OF_REFUND",
  },
  OTHER: {
    plain: "The dispute does not fit a standard reason, so send the order and delivery records you have.",
    needed: [],
    paypalEvidenceType: "OTHER",
  },
};

export function coverage(
  folder: EvidenceItem[],
  reason: PaypalReason,
): { have: EvidenceKind[]; missing: EvidenceKind[]; score: number } {
  const present = new Set(folder.map((i) => i.kind));
  const needed = REASON_REQUIREMENTS[reason].needed;
  const have = needed.filter((k) => present.has(k));
  const missing = needed.filter((k) => !present.has(k));
  return { have, missing, score: needed.length === 0 ? 1 : have.length / needed.length };
}
