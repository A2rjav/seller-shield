import { describe, expect, it } from "vitest";
import { DISPUTE_FEE_CENTS, recommend } from "@/lib/defense/recommend";

describe("recommend", () => {
  it("$12 order with $15 fee -> refund", () => {
    const r = recommend({ amountCents: 1200, itemCostCents: 400, disputeFeeCents: 1500, coverageScore: 1 });
    expect(r.action).toBe("refund");
    expect(r.reason).toContain("$4.00");
  });

  it("$850 order coverage 1.0 -> fight", () => {
    const r = recommend({ amountCents: 85000, itemCostCents: 30000, disputeFeeCents: DISPUTE_FEE_CENTS, coverageScore: 1 });
    expect(r.action).toBe("fight");
    expect(r.winProbability).toBeCloseTo(0.85, 10);
  });

  it("EV values match formula", () => {
    const amount = 20000, fee = 1500, score = 0.5;
    const p = 0.15 + 0.7 * score;
    const r = recommend({ amountCents: amount, itemCostCents: 7000, disputeFeeCents: fee, coverageScore: score });
    expect(r.winProbability).toBeCloseTo(p, 10);
    expect(r.expectedValueCents.fight).toBeCloseTo(p * amount - (1 - p) * fee, 6);
    expect(r.expectedValueCents.offer).toBe(Math.round(0.5 * amount));
    expect(r.expectedValueCents.refund).toBe(0);
    expect(r.offerCents).toBe(Math.round(0.5 * amount));
  });

  it("weak evidence on a mid-size order prefers the offer", () => {
    const r = recommend({ amountCents: 4000, itemCostCents: 1400, disputeFeeCents: 1500, coverageScore: 0 });
    expect(r.action).toBe("offer");
    expect(r.offerCents).toBe(2000);
  });
});
