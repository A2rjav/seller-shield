import { describe, it, expect } from "vitest";
import { evaluateProtection, SIGNATURE_THRESHOLD_CENTS, addressesMatch } from "@/lib/protection/rules";
import type { Address } from "@/lib/paypal/types";

type Shipment = { trackingNumber?: string; pushedToPaypal: boolean; signatureRequired: boolean; status?: string } | null;

const addr: Address = { line1: "12 Oak Street", city: "Portland", state: "OR", postalCode: "97201", countryCode: "US" };
const base = () => ({
  amountCents: 6000,
  currency: "USD",
  paypalShipAddress: addr as Address | null,
  shipToAddress: { ...addr } as Address | null,
  items: [{ kind: "physical" as "physical" | "service" | "digital" }],
  shipment: { trackingNumber: "1Z999", pushedToPaypal: true, signatureRequired: false, status: "DELIVERED" } as Shipment,
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
    expect(r.gaps).toContainEqual({ code: "address_mismatch", severity: "high", fix: "ship_to_paypal_address" });
    expect(r.status).toBe("at_risk");
  });
  it("line2 missing vs empty equal; different line2 differs", () => {
    expect(addressesMatch(addr, { ...addr, line2: "" })).toBe(true);
    expect(addressesMatch(addr, { ...addr, line2: "Apt 4" })).toBe(false);
  });
  it("missing PayPal address -> medium address_mismatch, still at_risk", () => {
    const o = base();
    o.paypalShipAddress = null;
    const r = evaluateProtection(o);
    expect(r.gaps).toContainEqual({ code: "address_mismatch", severity: "medium", fix: null });
    expect(r.status).toBe("at_risk");
  });
  it("our ship-to missing while PayPal has one -> no mismatch", () => {
    const o = base();
    o.shipToAddress = null;
    expect(codes(o)).not.toContain("address_mismatch");
  });
  it("amount at/over threshold without signature", () => {
    const o = base();
    o.amountCents = 85000;
    expect(evaluateProtection(o).gaps).toContainEqual({ code: "signature_required_over_threshold", severity: "high", fix: "require_signature" });
    o.shipment!.signatureRequired = true;
    expect(codes(o)).not.toContain("signature_required_over_threshold");
    o.shipment!.signatureRequired = false;
    o.amountCents = SIGNATURE_THRESHOLD_CENTS - 1;
    expect(codes(o)).not.toContain("signature_required_over_threshold");
  });
  it("tracking not pushed -> push_tracking", () => {
    const o = base();
    o.shipment!.pushedToPaypal = false;
    expect(evaluateProtection(o).gaps).toContainEqual({ code: "tracking_not_on_paypal", severity: "high", fix: "push_tracking" });
  });
  it("null shipment or no tracking number -> no_tracking", () => {
    const o = base();
    o.shipment = null;
    expect(evaluateProtection(o).gaps).toContainEqual({ code: "no_tracking", severity: "high", fix: null });
    o.shipment = { pushedToPaypal: false, signatureRequired: false };
    expect(codes(o)).toEqual(["no_tracking"]);
  });
  it("service item -> not_eligible, other gaps still listed", () => {
    const o = base();
    o.items = [{ kind: "service" }];
    o.shipment = null;
    const r = evaluateProtection(o);
    expect(r.status).toBe("not_eligible");
    expect(r.gaps.map((g) => g.code)).toEqual(expect.arrayContaining(["non_physical_item", "no_tracking"]));
  });
  it("digital item -> not_eligible", () => {
    const o = base();
    o.items = [{ kind: "digital" }];
    expect(evaluateProtection(o).status).toBe("not_eligible");
  });
  it("agent order with mandateVerified false/null -> gap; true -> none", () => {
    const o = base();
    o.source = "agent";
    o.mandateVerified = false;
    expect(evaluateProtection(o).gaps).toContainEqual({ code: "agent_mandate_missing_or_failed", severity: "high", fix: null });
    o.mandateVerified = null;
    expect(codes(o)).toContain("agent_mandate_missing_or_failed");
    o.mandateVerified = true;
    expect(codes(o)).not.toContain("agent_mandate_missing_or_failed");
  });
});
