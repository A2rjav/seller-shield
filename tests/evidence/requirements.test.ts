import { describe, expect, it } from "vitest";
import { coverage, REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import type { EvidenceItem, EvidenceKind } from "@/lib/evidence/folder";

const item = (kind: EvidenceKind): EvidenceItem => ({
  id: `ev:${kind}:x`, kind, title: kind, at: null, summary: kind, data: null, source: "seller_shield", simulated: false,
});

describe("REASON_REQUIREMENTS", () => {
  it("covers every reason with a plain sentence and an evidence type", () => {
    for (const r of Object.values(REASON_REQUIREMENTS)) {
      expect(r.plain.length).toBeGreaterThan(10);
      expect(r.paypalEvidenceType).toMatch(/^[A-Z_]+$/);
    }
    expect(REASON_REQUIREMENTS.MERCHANDISE_OR_SERVICE_NOT_RECEIVED.paypalEvidenceType).toBe("PROOF_OF_FULFILLMENT");
  });
});

describe("coverage", () => {
  it("NOT_RECEIVED with tracking + delivery + ship_address -> score 1", () => {
    const c = coverage([item("delivery"), item("tracking"), item("ship_address")], "MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    expect(c.score).toBe(1);
    expect(c.missing).toEqual([]);
  });
  it("NOT_RECEIVED with only delivery+tracking is partial", () => {
    const c = coverage([item("delivery"), item("tracking")], "MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    expect(c.missing).toEqual(["ship_address"]);
    expect(c.score).toBeCloseTo(2 / 3);
  });
  it("UNAUTHORISED without mandate -> missing includes mandate", () => {
    const c = coverage([item("payer_approval"), item("tracking")], "UNAUTHORISED");
    expect(c.missing).toContain("mandate");
    expect(c.have).toEqual(["payer_approval", "tracking"]);
  });
  it("score is 1 when nothing is needed", () => {
    expect(coverage([], "OTHER").score).toBe(1);
  });
});
