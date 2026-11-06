import { describe, expect, it } from "vitest";
import { statusCopy } from "@/lib/orders/status-copy";

describe("statusCopy", () => {
  it("COMPLETED is paid", () => expect(statusCopy("COMPLETED").kind).toBe("paid"));
  it("PENDING says PayPal is confirming", () => {
    const c = statusCopy("PENDING");
    expect(c.kind).toBe("pending");
    expect(c.headline).toMatch(/confirmed by PayPal/);
  });
  it.each(["DECLINED", "FAILED", "VOIDED", "weird"])("%s is shown as not paid", (s) => {
    const c = statusCopy(s);
    expect(c.kind).toBe("failed");
    expect(c.detail).toMatch(/not been charged/);
  });
});
