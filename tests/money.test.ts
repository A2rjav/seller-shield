import { describe, it, expect } from "vitest";
import { toCents, toPaypalAmount } from "@/lib/money";

describe("money", () => {
  it("parses decimal strings to cents", () => {
    expect(toCents("60.00")).toBe(6000);
    expect(toCents("0.5")).toBe(50);
  });
  it("rejects malformed amounts", () => {
    expect(() => toCents("1,234.56")).toThrow();
  });
  it("formats cents as PayPal amount strings", () => {
    expect(toPaypalAmount(6000)).toBe("60.00");
    expect(toPaypalAmount(5)).toBe("0.05");
  });
});
