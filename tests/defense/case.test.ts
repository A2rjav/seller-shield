import { describe, expect, it, vi } from "vitest";
import { templateCase, validateClaims, writeCase, type CaseDraft } from "@/lib/defense/case";
import { REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import type { EvidenceItem } from "@/lib/evidence/folder";

const item = (o: Partial<EvidenceItem> & { id: string; kind: EvidenceItem["kind"] }): EvidenceItem => ({
  title: o.kind, at: null, summary: "", data: {}, source: "storefront", simulated: false, ...o,
});

const folder: EvidenceItem[] = [
  item({ id: "ev:order:O1", kind: "order", title: "Order", at: "2026-11-05T10:00:00.000Z", summary: "Order O1 placed 2026-11-05 for $60.00" }),
  item({ id: "ev:tracking:S1", kind: "tracking", title: "Tracking", at: "2026-11-06T09:00:00.000Z", summary: "USPS 9400111899223344556677 pushed to PayPal 2026-11-06", data: { trackingNumber: "9400111899223344556677" }, source: "demo_carrier", simulated: true }),
  item({ id: "ev:delivery:S1", kind: "delivery", title: "Delivery", at: "2026-11-09T15:00:00.000Z", summary: "Delivered 2026-11-09 to Portland, OR 97214 (USPS 9400111899223344556677)", source: "demo_carrier", simulated: true }),
  item({ id: "ev:ship_address:O1", kind: "ship_address", title: "Ship-to", at: "2026-11-05T10:01:00.000Z", summary: "Ship-to Portland, OR 97214" }),
];
const reqs = REASON_REQUIREMENTS.MERCHANDISE_OR_SERVICE_NOT_RECEIVED;
const dispute = { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", dispute_amount: { currency_code: "USD", value: "60.00" } };
const input = { dispute, folder, requirements: reqs };

const good: CaseDraft = {
  summary: "The order was shipped and delivered.",
  timeline: [{ at: "2026-11-09", text: "Delivered on 2026-11-09 for the $60.00 order", evidenceIds: ["ev:delivery:S1", "ev:order:O1"] }],
  argument: [{ text: "Tracking 9400111899223344556677 shows delivery.", evidenceIds: ["ev:tracking:S1"] }],
  sellerNote: "",
};

describe("validateClaims", () => {
  it("accepts a grounded draft", () => expect(validateClaims(good, folder)).toEqual({ ok: true, problems: [] }));

  it("draft citing unknown id fails validation", () => {
    const d = { ...good, argument: [{ text: "x", evidenceIds: ["ev:nope"] }] };
    const r = validateClaims(d, folder);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("ev:nope");
  });

  it("entry without evidence ids fails", () => {
    expect(validateClaims({ ...good, argument: [{ text: "x", evidenceIds: [] }] }, folder).ok).toBe(false);
  });

  it("draft text with $99 not in any cited item fails", () => {
    const d = { ...good, argument: [{ text: "Buyer paid $99.", evidenceIds: ["ev:order:O1"] }] };
    expect(validateClaims(d, folder).ok).toBe(false);
  });

  it("catches a fabricated date and a fabricated tracking number, and reports all problems", () => {
    const d: CaseDraft = {
      ...good,
      timeline: [{ at: "", text: "Delivered on Nov 12, 2026", evidenceIds: ["ev:delivery:S1"] }],
      argument: [{ text: "Tracking 9400999999999999999999 confirms it, signed 11/12/2026.", evidenceIds: ["ev:tracking:S1"] }],
    };
    const r = validateClaims(d, folder);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts US and month-name dates that match a cited ISO date", () => {
    const d = { ...good, argument: [{ text: "Delivered Nov 9, 2026 (11/9/2026).", evidenceIds: ["ev:delivery:S1"] }] };
    expect(validateClaims(d, folder).ok).toBe(true);
  });

  it("summary and sellerNote may cite nothing but not invent figures", () => {
    expect(validateClaims({ ...good, summary: "Refund of $99 due." }, folder).ok).toBe(false);
    expect(validateClaims({ ...good, sellerNote: "Shipped 2026-12-31" }, folder).ok).toBe(false);
  });
});

describe("templateCase", () => {
  it("passes validateClaims by construction, in time order", () => {
    const t = templateCase(folder, reqs);
    expect(validateClaims(t, folder)).toEqual({ ok: true, problems: [] });
    expect(t.timeline.map((e) => e.evidenceIds[0])).toEqual(["ev:order:O1", "ev:ship_address:O1", "ev:tracking:S1", "ev:delivery:S1"]);
    expect(t.timeline.find((e) => e.evidenceIds[0] === "ev:delivery:S1")!.text).toContain("simulated");
    expect(t.argument.length).toBe(3);
  });
});

describe("templateCase for an agent order", () => {
  it("passes the validator with a realistic mandate folder", () => {
    const agentFolder: EvidenceItem[] = [
      ...folder,
      item({ id: "ev:mandate:m-O1", kind: "mandate", title: "Purchase mandate", at: "2026-11-05T09:00:00.000Z", source: "mandate",
        summary: "Mandate m-O1 for b@example.com: max $70.00, items 1 x ring-1, created 2026-11-05, expires 2026-11-06; verified: true; hash 3fa9c0d1e2b4a5f6", data: { hash: "3fa9c0d1e2b4a5f6", verified: true } }),
      item({ id: "ev:agent_identity:m-O1", kind: "agent_identity", title: "Agent identity", at: "2026-11-05T09:00:00.000Z", summary: "Agent agent-7 signature verified" }),
    ];
    const t = templateCase(agentFolder, REASON_REQUIREMENTS.UNAUTHORISED);
    expect(validateClaims(t, agentFolder)).toEqual({ ok: true, problems: [] });
    expect(t.argument.some((a) => a.evidenceIds.includes("ev:mandate:m-O1"))).toBe(true);
  });
});

describe("writeCase", () => {
  const bad: CaseDraft = { ...good, argument: [{ text: "Paid $99", evidenceIds: ["ev:order:O1"] }] };

  it("falls back to template after two invalid outputs", async () => {
    const askJson = vi.fn().mockResolvedValue({ ok: true, data: bad });
    const r = await writeCase(input, { askJson });
    expect(askJson).toHaveBeenCalledTimes(2);
    expect(askJson.mock.calls[1][0].user).toContain("$99");
    expect(r.usedFallback).toBe(true);
    expect(validateClaims(r.draft, folder).ok).toBe(true);
  });

  it("retries once and accepts a corrected draft", async () => {
    const askJson = vi.fn().mockResolvedValueOnce({ ok: true, data: bad }).mockResolvedValueOnce({ ok: true, data: good });
    const r = await writeCase(input, { askJson });
    expect(r).toEqual({ draft: good, usedFallback: false });
  });

  it("capped AI -> template, usedFallback true, no retry", async () => {
    const askJson = vi.fn().mockResolvedValue({ ok: false, reason: "cap" });
    const r = await writeCase(input, { askJson });
    expect(askJson).toHaveBeenCalledTimes(1);
    expect(r.usedFallback).toBe(true);
  });

  it("prompt states the evidence-only rule, marks simulated items, and never includes raw data", async () => {
    const askJson = vi.fn().mockResolvedValue({ ok: true, data: good });
    await writeCase(input, { askJson });
    const { system, user } = askJson.mock.calls[0][0];
    expect(system).toMatch(/only/i);
    expect(user).toContain("ev:delivery:S1 | delivery | 2026-11-09T15:00:00.000Z |");
    expect(user).toMatch(/\| true\b/);
    expect(user).not.toContain("trackingNumber");
  });
});

// ---- Fix round 1 ----
const cite = (text: string, ids = ["ev:delivery:S1"]): CaseDraft => ({ ...good, argument: [{ text, evidenceIds: ids }] });
const fails = (text: string, ids?: string[]) => expect(validateClaims(cite(text, ids), folder).ok, text).toBe(false);
const passes = (text: string, ids?: string[]) => expect(validateClaims(cite(text, ids), folder), text).toEqual({ ok: true, problems: [] });

describe("timeline.at", () => {
  it("fabricated at fails; at matching a cited item date or empty passes", () => {
    const t = (at: string): CaseDraft => ({ ...good, timeline: [{ at, text: "Delivered", evidenceIds: ["ev:delivery:S1"] }] });
    expect(validateClaims(t("2026-11-12"), folder).ok).toBe(false);
    expect(validateClaims(t("sometime"), folder).ok).toBe(false);
    expect(validateClaims(t("2026-11-09"), folder).ok).toBe(true);
    expect(validateClaims(t("2026-11-09T15:00:00.000Z"), folder).ok).toBe(true);
    expect(validateClaims(t(""), folder).ok).toBe(true);
  });
});

describe("validator formats", () => {
  it("year-less month-day dates", () => {
    fails("Delivered November 12"); passes("Delivered November 9");
    fails("Delivered Nov. 12th"); passes("Delivered Nov. 9th");
    fails("Delivered 12/11"); passes("Delivered 11/9");
  });
  it("day-month order and slash ISO", () => {
    fails("Delivered 12 November 2026"); passes("Delivered 9 November 2026");
    fails("Delivered on 2026/11/12"); passes("Delivered on 2026/11/09");
  });
  it("amounts without a dollar sign and with one decimal digit", () => {
    const o = ["ev:order:O1"];
    fails("Paid 75 USD", o); passes("Paid 60.00 USD", o);
    fails("Paid USD 75", o); passes("Paid USD 60", o);
    fails("Paid 75 dollars", o); passes("Paid 60 dollars", o);
    fails("Paid $60.5", o); passes("Paid $60.0", o);
  });
  it("tracking numbers: lowercase, spaced and dashed", () => {
    fails("Tracking 9400999999999999999999 here"); fails("Tracking 9400 9999 9999 9999 9999 99");
    fails("Tracking 9400-9999-9999-9999-9999-99");
    passes("Tracking 9400 1118 9922 3344 5566 77"); passes("Tracking 9400-1118-9922-3344-5566-77");
    const f2 = [item({ id: "a", kind: "tracking", summary: "Tracking AB12345678CD" })];
    expect(validateClaims({ ...good, timeline: [], argument: [{ text: "see ab12345678cd", evidenceIds: ["a"] }] }, f2).ok).toBe(true);
    expect(validateClaims({ ...good, timeline: [], argument: [{ text: "see zz12345678cd", evidenceIds: ["a"] }] }, f2).ok).toBe(false);
  });
});

describe("amounts are structural, not digit runs", () => {
  it("ZIP-derived and year-derived fake amounts fail", () => {
    fails("Paid $972.14", ["ev:delivery:S1"]); // zip 97214
    fails("Paid $20.26", ["ev:delivery:S1"]); // year 2026
    fails("Paid $972.14", ["ev:ship_address:O1"]);
  });
  it("hex hash digits do not allow amounts, but *Cents and amount.value data keys do", () => {
    const f = [item({ id: "m", kind: "mandate", summary: "hash 3fa9c0d1e2b4a5f6 7000", data: { maxAmountCents: 7000, amount: { currency_code: "USD", value: "42.50" }, hash: "3fa9c0d1e2b4a5f6" } })];
    const v = (t: string) => validateClaims({ ...good, timeline: [], argument: [{ text: t, evidenceIds: ["m"] }] }, f).ok;
    expect(v("limit $70.00")).toBe(true);
    expect(v("charged $42.50")).toBe(true);
    expect(v("charged $39.00")).toBe(false);
    expect(v("charged $70.00 or $3.00")).toBe(false);
  });
});

describe("prompt hygiene", () => {
  it("agent folder prompt contains no buyer email", async () => {
    const agent = [...folder, item({ id: "ev:mandate:m1", kind: "mandate", at: "2026-11-05T09:00:00.000Z", summary: "Mandate m1 for bea.buyer@example.com: max $70.00; verified: true" })];
    const askJson = vi.fn().mockResolvedValue({ ok: true, data: good });
    await writeCase({ dispute, folder: agent, requirements: REASON_REQUIREMENTS.UNAUTHORISED }, { askJson });
    const { user, system } = askJson.mock.calls[0][0];
    expect(user).not.toContain("@");
    expect(system).not.toContain("@");
    expect(user).toContain("[buyer email]");
  });
});
