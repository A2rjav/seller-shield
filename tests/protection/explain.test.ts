import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ai/gemini", () => ({ askJson: vi.fn() }));
import { askJson } from "@/lib/ai/gemini";
import { explainGaps, FALLBACK_TEXT } from "@/lib/protection/explain";
import type { ProtectionResult, GapCode } from "@/lib/protection/rules";

const ask = vi.mocked(askJson);
const order = {
  amountCents: 85000,
  currency: "USD",
  paypalShipAddress: { line1: "1 A St", city: "Portland", state: "OR", postalCode: "97201", countryCode: "US" },
  shipToAddress: { line1: "2 B St", city: "Salem", state: "OR", postalCode: "97301", countryCode: "US" },
};
const result: ProtectionResult = {
  status: "at_risk",
  gaps: [
    { code: "address_mismatch", severity: "high", fix: "ship_to_paypal_address" },
    { code: "tracking_not_on_paypal", severity: "high", fix: "push_tracking" },
  ],
};

describe("explainGaps", () => {
  it("uses FALLBACK_TEXT when askJson returns cap", async () => {
    ask.mockResolvedValueOnce({ ok: false, reason: "cap" });
    const r = await explainGaps(result, order);
    expect(r.usedFallback).toBe(true);
    expect(r.lines).toEqual([
      { code: "address_mismatch", text: FALLBACK_TEXT.address_mismatch },
      { code: "tracking_not_on_paypal", text: FALLBACK_TEXT.tracking_not_on_paypal },
    ]);
  });
  it("makes no AI call when there are no gaps", async () => {
    ask.mockClear();
    const r = await explainGaps({ status: "protected", gaps: [] }, order);
    expect(ask).not.toHaveBeenCalled();
    expect(r).toEqual({ lines: [], usedFallback: false });
  });
  it("uses model text when valid, one call for all gaps", async () => {
    ask.mockClear();
    ask.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ code: "address_mismatch", text: "Ship to Portland." }, { code: "tracking_not_on_paypal", text: "Add tracking in PayPal." }] },
    });
    const r = await explainGaps(result, order);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(r.usedFallback).toBe(false);
    expect(r.lines[0].text).toBe("Ship to Portland.");
  });
  it("invalid code from model falls back for that gap", async () => {
    ask.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ code: "bogus" as GapCode, text: "x" }, { code: "tracking_not_on_paypal", text: "Add tracking in PayPal." }] },
    });
    const r = await explainGaps(result, order);
    expect(r.usedFallback).toBe(true);
    expect(r.lines).toEqual([
      { code: "address_mismatch", text: FALLBACK_TEXT.address_mismatch },
      { code: "tracking_not_on_paypal", text: "Add tracking in PayPal." },
    ]);
  });
  it("over-long text falls back", async () => {
    ask.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ code: "address_mismatch", text: Array(26).fill("word").join(" ") }, { code: "tracking_not_on_paypal", text: "ok" }] },
    });
    const r = await explainGaps(result, order);
    expect(r.lines[0].text).toBe(FALLBACK_TEXT.address_mismatch);
  });
  it("every fallback is <= 25 words", () => {
    for (const t of Object.values(FALLBACK_TEXT)) expect(t.split(/\s+/).length).toBeLessThanOrEqual(25);
  });
});
