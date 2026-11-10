import { describe, expect, it, vi } from "vitest";
import { CASE_MAX_TOKENS, CITATION_CLAIM, caseNotes, caseSummary, templateCase, validateClaims, writeCase, type CaseDraft } from "@/lib/defense/case";
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

  it("catches fabricated month-name dates in any casing", () => {
    for (const text of ["Delivered nov 12, 2026.", "Delivered NOVEMBER 12.", "Delivered 12 NOV 2026."]) {
      const d = { ...good, argument: [{ text, evidenceIds: ["ev:delivery:S1"] }] };
      expect(validateClaims(d, folder).ok, text).toBe(false);
    }
  });

  it("accepts real month-name dates in any casing", () => {
    for (const text of ["Delivered nov 9, 2026.", "Delivered NOVEMBER 9.", "Delivered 9 NOV 2026."]) {
      const d = { ...good, argument: [{ text, evidenceIds: ["ev:delivery:S1"] }] };
      expect(validateClaims(d, folder).ok, text).toBe(true);
    }
  });

  it("ordinary words before a number are not read as dates", () => {
    for (const text of ["We marked 2 attempts.", "The buyer decided 3 times.", "It may 2 days late.", "Please separate 4 boxes."]) {
      const d = { ...good, argument: [{ text, evidenceIds: ["ev:delivery:S1"] }] };
      expect(validateClaims(d, folder), text).toEqual({ ok: true, problems: [] });
    }
  });

  it("still extracts Nov 12, november 12th and May 5, 2026 (fabricated ones are caught)", () => {
    for (const text of ["Delivered Nov 12.", "Delivered november 12th.", "Delivered May 5, 2026.", "Delivered may 5th.", "Delivered 5 May 2026."]) {
      const d = { ...good, argument: [{ text, evidenceIds: ["ev:delivery:S1"] }] };
      expect(validateClaims(d, folder).ok, text).toBe(false);
    }
  });

  it("accepts US and month-name dates that match a cited ISO date", () => {
    const d = { ...good, argument: [{ text: "Delivered Nov 9, 2026 (11/9/2026).", evidenceIds: ["ev:delivery:S1"] }] };
    expect(validateClaims(d, folder).ok).toBe(true);
  });

  it("summary may cite nothing but not invent figures", () => {
    expect(validateClaims({ ...good, summary: "Refund of $99 due." }, folder).ok).toBe(false);
    expect(validateClaims({ ...good, summary: "Shipped 2026-12-31" }, folder).ok).toBe(false);
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
    expect(r).toEqual({ draft: { summary: caseSummary(folder, reqs), timeline: good.timeline, argument: good.argument }, usedFallback: false });
  });

  it("retries after an invalid (unparseable) answer instead of falling back at once", async () => {
    const askJson = vi.fn().mockResolvedValueOnce({ ok: false, reason: "invalid" }).mockResolvedValueOnce({ ok: true, data: good });
    const r = await writeCase(input, { askJson });
    expect(askJson).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(false);
  });

  it("keeps no AI free text: summary is built in code and sellerNote is dropped", async () => {
    const data = { ...good, summary: "We always ship fast, trust us.", sellerNote: "Please rule for me." };
    const askJson = vi.fn().mockResolvedValue({ ok: true, data });
    const r = await writeCase(input, { askJson });
    expect(r.usedFallback).toBe(false);
    expect(r.draft.summary).toBe(caseSummary(folder, reqs));
    expect(Object.keys(r.draft).sort()).toEqual(["argument", "summary", "timeline"]);
    expect(JSON.stringify(r.draft)).not.toContain("trust us");
  });

  it("asks the quality tier for the case body only, with a 4096-token budget", async () => {
    const askJson = vi.fn().mockResolvedValue({ ok: true, data: good });
    await writeCase(input, { askJson });
    const opts = askJson.mock.calls[0][0];
    expect(opts.tier).toBe("quality");
    expect(opts.maxTokens).toBe(CASE_MAX_TOKENS);
    expect(CASE_MAX_TOKENS).toBe(4096);
    expect(opts.system).not.toMatch(/sellerNote|summary,/);
    expect(opts.schema.safeParse({ timeline: [], argument: [] }).success).toBe(true);
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

describe("caseSummary (deterministic)", () => {
  it("states the claim, counts, coverage and the citation rule, with no figures", () => {
    const s = caseSummary(folder, reqs);
    expect(s).toBe(
      "The buyer says the order never arrived. This response is built from 4 evidence items (2 simulated). " +
        "Evidence this claim needs that is on file: tracking number, delivery confirmation, PayPal ship-to address. Missing: none. " +
        "Every timeline and argument entry cites the evidence item ids.",
    );
    expect(s).toContain(CITATION_CLAIM);
    expect(validateClaims({ ...good, summary: s }, folder).ok).toBe(true);
  });
  it("lists what is missing", () => {
    const s = caseSummary(folder.slice(0, 1), reqs);
    expect(s).toContain("built from 1 evidence item.");
    expect(s).toContain("on file: none. Missing: tracking number, delivery confirmation, PayPal ship-to address.");
  });
  it("templateCase uses it", () => {
    expect(templateCase(folder, reqs).summary).toBe(caseSummary(folder, reqs));
  });
});

describe("caseNotes (what PayPal receives)", () => {
  const draft: CaseDraft = { summary: "Summary line.", timeline: good.timeline, argument: good.argument };
  it("is the summary plus every entry with its evidence ids", () => {
    expect(caseNotes(draft)).toBe(
      "Summary line.\n\nTimeline:\n- 2026-11-09 Delivered on 2026-11-09 for the $60.00 order [ev:delivery:S1, ev:order:O1]" +
        "\n\nWhy this answers the claim:\n- Tracking 9400111899223344556677 shows delivery. [ev:tracking:S1]",
    );
  });
  it("cuts at whole lines within the limit", () => {
    const many: CaseDraft = { ...draft, argument: Array.from({ length: 60 }, (_, i) => ({ text: `Point ${i} ${"x".repeat(40)}`, evidenceIds: ["ev:order:O1"] })) };
    const n = caseNotes(many);
    expect(n.length).toBeLessThanOrEqual(2000);
    expect(n.length).toBeGreaterThan(1900);
    expect(n.split("\n").every((l) => l === "" || l.endsWith("]") || l.endsWith(":") || l === "Summary line.")).toBe(true);
  });
});

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
