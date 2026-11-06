import { describe, it, expect } from "vitest";
import { evaluateProtection, PROTECTION_CAP_CENTS, addressesMatch } from "@/lib/protection/rules";
import type { Address } from "@/lib/paypal/types";

type Shipment = { trackingNumber?: string; pushedToPaypal: boolean; status?: string } | null;

const addr: Address = { line1: "12 Oak Street", city: "Portland", state: "OR", postalCode: "97201", countryCode: "US" };
const base = () => ({
  amountCents: 6000,
  currency: "USD",
  paypalShipAddress: addr as Address | null,
  shipToAddress: { ...addr } as Address | null,
  items: [{ kind: "physical" as "physical" | "service" | "digital" }],
  shipment: { trackingNumber: "1Z999", pushedToPaypal: true, status: "delivered" } as Shipment,
  source: "human" as "human" | "agent",
  mandateVerified: null as boolean | null,
});
const codes = (o: ReturnType<typeof base>) => evaluateProtection(o).gaps.map((g) => g.code);

describe("evaluateProtection", () => {
  it("delivered + tracking on PayPal + address match -> protected", () => {
    expect(evaluateProtection(base())).toEqual({ status: "protected", gaps: [] });
  });
  it("case/whitespace/punctuation differences are not a mismatch", () => {
    const o = base();
    o.shipToAddress = { line1: "  12  OAK street. ", line2: "", city: "portland ", state: "or", postalCode: "97201-1234", countryCode: "us" };
    expect(codes(o)).not.toContain("address_mismatch");
  });
  it("different street -> address_mismatch high with fix", () => {
    const o = base();
    o.shipToAddress = { ...addr, line1: "99 Elm Road" };
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "address_mismatch", severity: "high", fix: "ship_to_paypal_address", basis: "paypal_policy" });
    expect(r.status).toBe("at_risk");
  });
  it("line2 missing vs empty equal; different line2 differs", () => {
    expect(addressesMatch(addr, { ...addr, line2: "" })).toBe(true);
    expect(addressesMatch(addr, { ...addr, line2: "Apt 4" })).toBe(false);
  });
  it("missing PayPal address -> medium address_mismatch, pending", () => {
    const o = base();
    o.paypalShipAddress = null;
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "address_mismatch", severity: "medium", fix: null, basis: "paypal_policy" });
    expect(r.status).toBe("pending");
  });
  it("our ship-to missing while PayPal has one -> no mismatch", () => {
    const o = base();
    o.shipToAddress = null;
    expect(codes(o)).not.toContain("address_mismatch");
  });
  it("amount 1_000_001 -> over_protection_cap, not_eligible; exactly the cap is fine", () => {
    const o = base();
    o.amountCents = PROTECTION_CAP_CENTS + 1;
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "over_protection_cap", severity: "high", fix: null, basis: "paypal_policy" });
    expect(r.status).toBe("not_eligible");
    o.amountCents = PROTECTION_CAP_CENTS;
    expect(evaluateProtection(o)).toEqual({ status: "protected", gaps: [] });
  });
  it("tracking exists but not pushed -> tracking_not_on_paypal medium push_tracking (seller_shield)", () => {
    const o = base();
    o.shipment!.pushedToPaypal = false;
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "tracking_not_on_paypal", severity: "medium", fix: "push_tracking", basis: "seller_shield" });
    expect(r.status).toBe("pending");
  });
  it("shipped, tracking on PayPal, not yet delivered -> no_delivery_confirmation, pending", () => {
    const o = base();
    o.shipment!.status = "in_transit";
    const r = evaluateProtection(o);
    expect(r.gaps).toEqual([{ code: "no_delivery_confirmation", severity: "medium", fix: null, basis: "paypal_policy" }]);
    expect(r.status).toBe("pending");
  });
  it("null shipment or no tracking number -> no_tracking only", () => {
    const o = base();
    o.shipment = null;
    const r = evaluateProtection(o);
    expect(r.gaps).toEqual([{ code: "no_tracking", severity: "high", fix: null, basis: "paypal_policy" }]);
    expect(r.status).toBe("at_risk");
    o.shipment = { pushedToPaypal: false };
    expect(codes(o)).toEqual(["no_tracking"]);
  });
  it("service item -> intangible_needs_proof (medium), not not_eligible", () => {
    const o = base();
    o.items = [{ kind: "service" }];
    const r = evaluateProtection(o);
    expect(r.gaps).toEqual([{ code: "intangible_needs_proof", severity: "medium", fix: null, basis: "paypal_policy" }]);
    expect(r.status).toBe("pending");
  });
  it("digital item -> intangible_needs_proof", () => {
    const o = base();
    o.items = [{ kind: "digital" }];
    expect(codes(o)).toEqual(["intangible_needs_proof"]);
  });
  it("agent order with mandateVerified false/null -> gap (seller_shield); true -> none", () => {
    const o = base();
    o.source = "agent";
    o.mandateVerified = false;
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "agent_mandate_missing_or_failed", severity: "high", fix: null, basis: "seller_shield" });
    expect(r.status).toBe("at_risk");
    o.mandateVerified = null;
    expect(codes(o)).toContain("agent_mandate_missing_or_failed");
    o.mandateVerified = true;
    expect(codes(o)).not.toContain("agent_mandate_missing_or_failed");
  });
});
