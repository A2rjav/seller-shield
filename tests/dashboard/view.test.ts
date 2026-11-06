import { describe, expect, it } from "vitest";
import {
  basisLabel,
  disputeStatusChip,
  dueCountdown,
  evFormulaText,
  formatEv,
  GAP_TITLE,
  isCoveredBySellerProtection,
  offerBlockedReason,
  protectedText,
  SELLER_PROTECTION_COVERED_REASONS,
  mandateBadge,
  mandateStateOf,
  protectionBadge,
  reasonLabel,
} from "@/lib/dashboard/view";

describe("protectionBadge", () => {
  it("maps every status to a text label and a tone (never colour alone)", () => {
    expect(protectionBadge("protected")).toEqual({ label: "Protected", tone: "green" });
    expect(protectionBadge("pending")).toEqual({ label: "Pending", tone: "amber" });
    expect(protectionBadge("at_risk")).toEqual({ label: "At risk", tone: "red" });
    expect(protectionBadge("not_eligible")).toEqual({ label: "Not eligible", tone: "gray" });
  });
  it("treats an order without a check as not checked", () => {
    expect(protectionBadge(null)).toEqual({ label: "Not checked", tone: "gray" });
  });
});

describe("mandate state", () => {
  it("derives verified / failed / not checked", () => {
    expect(mandateStateOf({ verified: true })).toBe("verified");
    expect(mandateStateOf({ verified: false })).toBe("failed");
    expect(mandateStateOf(null)).toBe("not_checked");
    expect(mandateBadge("verified")).toEqual({ label: "Mandate verified", tone: "green" });
    expect(mandateBadge("failed")).toEqual({ label: "Mandate failed", tone: "red" });
    expect(mandateBadge("not_checked")).toEqual({ label: "Mandate not checked", tone: "gray" });
  });
});

describe("labels", () => {
  it("has a title for every gap and names the basis", () => {
    expect(GAP_TITLE.tracking_not_on_paypal).toBe("Tracking not on PayPal");
    expect(basisLabel("paypal_policy")).toBe("PayPal policy");
    expect(basisLabel("seller_shield")).toBe("Seller Shield tip");
  });
  it("puts dispute reasons in plain words", () => {
    expect(reasonLabel("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toBe("Item not received");
    expect(reasonLabel("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toBe("Not as described");
    expect(reasonLabel("UNAUTHORISED")).toBe("Unauthorized payment");
    expect(reasonLabel("SOMETHING_NEW")).toBe("Other");
  });
  it("protected copy says when delivery is simulated (I2)", () => {
    expect(protectedText("All requirements met", false)).toBe("All requirements met");
    expect(protectedText("All requirements met", true)).toBe("All requirements met (delivery Simulated)");
  });
  it("one shared covered-reasons list: only item-not-received and unauthorised (M1)", () => {
    expect([...SELLER_PROTECTION_COVERED_REASONS]).toEqual(["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "UNAUTHORISED"]);
    expect(isCoveredBySellerProtection("UNAUTHORISED")).toBe(true);
    expect(isCoveredBySellerProtection("DUPLICATE_TRANSACTION")).toBe(false);
    expect(isCoveredBySellerProtection("OTHER")).toBe(false);
  });
  it("offers are blocked at the chargeback stage, with a reason (M9)", () => {
    expect(offerBlockedReason("CHARGEBACK")).toMatch(/chargeback/i);
    expect(offerBlockedReason("chargeback")).toMatch(/chargeback/i);
    expect(offerBlockedReason("INQUIRY")).toBeNull();
    expect(offerBlockedReason(null)).toBeNull();
  });
  it("knows Not As Described is outside Seller Protection", () => {
    expect(isCoveredBySellerProtection("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toBe(false);
    expect(isCoveredBySellerProtection("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toBe(true);
  });
  it("maps PayPal dispute statuses to chips", () => {
    expect(disputeStatusChip("WAITING_FOR_SELLER_RESPONSE")).toEqual({ label: "Needs your response", tone: "red" });
    expect(disputeStatusChip("UNDER_REVIEW")).toEqual({ label: "PayPal reviewing", tone: "amber" });
    expect(disputeStatusChip("RESOLVED")).toEqual({ label: "Resolved", tone: "gray" });
    expect(disputeStatusChip("WEIRD")).toEqual({ label: "Weird", tone: "gray" });
  });
});

describe("dueCountdown", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("counts down days and hours", () => {
    expect(dueCountdown("2026-11-09T16:00:00Z", now)).toEqual({ label: "3d 4h left", urgency: "ok" });
  });
  it("is urgent inside 48 hours", () => {
    expect(dueCountdown(new Date("2026-11-07T18:30:00Z"), now)).toEqual({ label: "1d 6h left", urgency: "soon" });
    expect(dueCountdown(new Date("2026-11-06T12:45:00Z"), now)).toEqual({ label: "45m left", urgency: "soon" });
  });
  it("says overdue and handles no deadline", () => {
    expect(dueCountdown("2026-11-06T10:00:00Z", now)).toEqual({ label: "Overdue by 2h", urgency: "overdue" });
    expect(dueCountdown(null, now)).toEqual({ label: "No deadline", urgency: "none" });
  });
});

describe("EV formatting", () => {
  it("rounds fractional cents and keeps the sign", () => {
    expect(formatEv(4012.5)).toBe("$40.13");
    expect(formatEv(-975)).toBe("-$9.75");
    expect(formatEv(0)).toBe("$0.00");
  });
  it("spells out the estimate formula with the inputs", () => {
    const t = evFormulaText({ winProbability: 0.85, amountCents: 6000, feeCents: 1500 });
    expect(t).toContain("estimate");
    expect(t).toContain("0.15 + 0.7");
    expect(t).toContain("85%");
    expect(t).toContain("$60.00");
    expect(t).toContain("$15.00");
  });
});

describe("mandate failure and evidence source labels", () => {
  it("explains mandate failures in plain words", async () => {
    const { mandateFailureLabel, evidenceSourceLabel } = await import("@/lib/dashboard/view");
    expect(mandateFailureLabel("payer_email_mismatch")).toBe("The PayPal payer email did not match the shopper");
    expect(mandateFailureLabel("something_new")).toBe("Something new");
    expect(evidenceSourceLabel("demo_carrier")).toBe("Demo carrier");
    expect(evidenceSourceLabel("paypal")).toBe("PayPal");
  });
});

describe("evidence kind labels", () => {
  it("names each kind in plain words", async () => {
    const { evidenceKindLabel } = await import("@/lib/dashboard/view");
    expect(evidenceKindLabel("ship_address")).toBe("PayPal ship-to address");
    expect(evidenceKindLabel("mandate")).toBe("Signed purchase mandate");
    expect(evidenceKindLabel("new_kind")).toBe("New kind");
  });
});
