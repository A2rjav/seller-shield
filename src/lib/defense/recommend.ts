/**
 * PayPal US business fees page, "dispute fee" row (per-dispute fee charged to the seller).
 * This value MUST be re-checked against https://www.paypal.com/us/business/paypal-business-fees before launch.
 */
export const DISPUTE_FEE_CENTS = 1500;

export type Action = "fight" | "offer" | "refund";

export type Recommendation = {
  action: Action;
  winProbability: number;
  /** Expected dollars (in cents) the seller keeps from the sale under each action. */
  expectedValueCents: Record<Action, number>;
  offerCents?: number;
  reason: string;
};

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * EV = expected money the seller keeps from the sale (estimates, not PayPal outcomes):
 *   p      = 0.15 + 0.7 * coverageScore
 *   fight  = p * amount - (1 - p) * fee
 *   offer  = round(0.5 * amount)   (assumes the buyer accepts a 50% partial refund)
 *   refund = 0
 * Ties prefer the least risky action: refund > offer > fight.
 * An order smaller than fee + $5 is always refunded.
 */
export function recommend(input: {
  amountCents: number;
  itemCostCents: number;
  disputeFeeCents: number;
  coverageScore: number;
}): Recommendation {
  const { amountCents, itemCostCents, disputeFeeCents: fee } = input;
  const score = Math.min(1, Math.max(0, input.coverageScore));
  const p = 0.15 + 0.7 * score;
  const offerCents = Math.round(0.5 * amountCents);
  const ev: Record<Action, number> = { fight: p * amountCents - (1 - p) * fee, offer: offerCents, refund: 0 };
  const cost = `item cost ${usd(itemCostCents)} is already spent either way`;

  if (amountCents < fee + 500) {
    return {
      action: "refund",
      winProbability: p,
      expectedValueCents: ev,
      reason: `The ${usd(amountCents)} order is too small to be worth a ${usd(fee)} dispute fee risk; refund it (${cost}).`,
    };
  }

  let action: Action = "refund";
  for (const a of ["offer", "fight"] as const) if (ev[a] > ev[action]) action = a;

  const reasons: Record<Action, string> = {
    fight: `Evidence-based win chance is an estimated ${Math.round(p * 100)}%; fighting keeps an expected ${usd(Math.round(ev.fight))} of the ${usd(amountCents)} sale, more than the alternatives (${cost}).`,
    offer: `A 50% partial refund of ${usd(offerCents)} keeps more than fighting (expected ${usd(Math.round(ev.fight))} at an estimated ${Math.round(p * 100)}% win chance), assuming the buyer accepts (${cost}).`,
    refund: `Fighting is expected to keep ${usd(Math.round(ev.fight))} and an offer ${usd(offerCents)}, no better than refunding (${cost}).`,
  };
  return {
    action,
    winProbability: p,
    expectedValueCents: ev,
    ...(action === "offer" ? { offerCents } : {}),
    reason: reasons[action],
  };
}
