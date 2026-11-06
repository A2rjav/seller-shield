import { z } from "zod";
import { askJson } from "@/lib/ai/gemini";
import type { Address } from "@/lib/paypal/types";
import type { GapCode, ProtectionResult } from "./rules";

export const FALLBACK_TEXT: Record<GapCode, string> = {
  address_mismatch: "The address you are shipping to differs from the one PayPal has. Ship to the PayPal address to stay covered.",
  no_tracking: "This order has no tracking number yet. Ship it with a trackable service and add the number.",
  tracking_not_on_paypal: "Your tracking number has not been added to PayPal yet. Send it to PayPal so shipment can be proven.",
  no_delivery_confirmation: "The carrier has not marked this order delivered yet. Delivered status and date are needed if the buyer says it never arrived.",
  over_protection_cap: "This order is over PayPal's $10,000 Seller Protection limit, so it is generally not covered. Consider splitting it.",
  intangible_needs_proof: "Services and digital items are covered only with strong proof of delivery. Keep records of what was sent, when, and to whom.",
  agent_mandate_missing_or_failed: "An AI agent placed this order, but its permission from the buyer is missing or failed checks. Review it before shipping.",
};

const NO_PAYPAL_ADDRESS_TEXT =
  "PayPal has no shipping address on file for this order, so we cannot confirm your ship-to address matches. Check the order in PayPal.";

export type ExplainOrder = {
  amountCents: number;
  currency: string;
  paypalShipAddress: Address | null;
  shipToAddress: Address | null;
};

const schema = z.object({ lines: z.array(z.object({ code: z.string(), text: z.string() })) });
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const place = (a: Address | null) => (a ? `${a.city}, ${a.state}` : "unknown");

export async function explainGaps(
  result: ProtectionResult,
  order: ExplainOrder,
): Promise<{ lines: { code: GapCode; text: string }[]; usedFallback: boolean }> {
  const gaps = result.gaps;
  if (gaps.length === 0) return { lines: [], usedFallback: false };

  const facts = {
    order_amount: `${(order.amountCents / 100).toFixed(2)} ${order.currency}`,
    paypal_address_city_state: place(order.paypalShipAddress),
    ship_to_city_state: place(order.shipToAddress),
    gaps: gaps.map((g) => g.code),
  };
  const res = await askJson({
    system:
      "You help a small US seller keep PayPal Seller Protection. For each gap code given, write one plain, friendly sentence of at most 25 words saying what is wrong and what to do. Use only the facts provided. Do not invent facts, numbers, dates or policy details. Return every gap code exactly as given.",
    user: JSON.stringify(facts),
    schema,
    maxTokens: 600,
  }).catch(() => ({ ok: false as const, reason: "error" as const }));

  const byCode = new Map<string, string>();
  if (res.ok) {
    const allowed = new Set<string>(gaps.map((g) => g.code));
    for (const l of res.data.lines) {
      const text = l.text.trim();
      if (allowed.has(l.code) && !byCode.has(l.code) && text && wordCount(text) <= 25) byCode.set(l.code, text);
    }
  }
  let usedFallback = false;
  const lines = gaps.map((g) => {
    const t = byCode.get(g.code);
    if (t) return { code: g.code, text: t };
    usedFallback = true;
    const text = g.code === "address_mismatch" && !order.paypalShipAddress ? NO_PAYPAL_ADDRESS_TEXT : FALLBACK_TEXT[g.code];
    return { code: g.code, text };
  });
  return { lines, usedFallback };
}
