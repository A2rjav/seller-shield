import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { coverNotices, formatRow, renderEvidencePdf, sanitize, SIMULATED_BANNER } from "@/lib/defense/pdf";
import { templateCase } from "@/lib/defense/case";
import { REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import type { EvidenceItem } from "@/lib/evidence/folder";

const folder: EvidenceItem[] = [
  { id: "ev:order:O1", kind: "order", title: "Order — “O1”", at: "2026-11-05T10:00:00.000Z", summary: "Order placed 2026-11-05 for $60.00 — paid ✓", data: {}, source: "storefront", simulated: false },
  { id: "ev:mandate:M1", kind: "mandate", title: "Purchase mandate", at: "2026-11-05T09:00:00.000Z", summary: "Mandate M1; verified: true; hash abc123", data: { hash: "abc123", verified: true }, source: "mandate", simulated: false },
  { id: "ev:delivery:S1", kind: "delivery", title: "Delivery", at: "2026-11-09T15:00:00.000Z", summary: "Delivered 2026-11-09 ".repeat(30), data: {}, source: "demo_carrier", simulated: true },
];
const dispute = { dispute_id: "PP-D-4242", reason: "UNAUTHORISED", dispute_amount: { currency_code: "USD", value: "60.00" } };

describe("renderEvidencePdf", () => {
  it("has >= 2 pages and carries the dispute id; sanitizes unencodable characters", async () => {
    const draft = templateCase(folder, REASON_REQUIREMENTS.UNAUTHORISED);
    const bytes = await renderEvidencePdf({ dispute, draft, folder });
    expect(bytes).toBeInstanceOf(Uint8Array);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toContain("PP-D-4242");
  });
});

describe("formatRow", () => {
  const byId = new Map(folder.map((i) => [i.id, i]));
  it("marks rows citing a simulated item, and only those", () => {
    expect(formatRow("Delivered", ["ev:order:O1", "ev:delivery:S1"], byId, "2026-11-09T15:00:00Z")).toBe(
      "2026-11-09  Delivered  [ev:order:O1, ev:delivery:S1] [SIMULATED]",
    );
    expect(formatRow("Ordered", ["ev:order:O1"], byId)).not.toContain("SIMULATED");
  });
});

describe("cover notices (I1, I2)", () => {
  it("a simulated dispute gets the SIMULATED banner first; a real one does not", () => {
    expect(SIMULATED_BANNER).toBe("SIMULATED DISPUTE - demo data, not from PayPal");
    expect(coverNotices({ simulated: true })[0]).toBe(SIMULATED_BANNER);
    expect(coverNotices({ simulated: false })).not.toContain(SIMULATED_BANNER);
  });
  it("claims citations only for timeline and argument entries", () => {
    const text = coverNotices({ simulated: false }).join(" ");
    expect(text).toContain("Every timeline and argument entry cites the evidence item ids");
    expect(text).not.toContain("Every statement");
  });
  it("the rendered PDF of a simulated dispute carries the banner in its metadata", async () => {
    const draft = templateCase(folder, REASON_REQUIREMENTS.UNAUTHORISED);
    const sim = await PDFDocument.load(await renderEvidencePdf({ dispute, draft, folder, simulated: true }));
    expect(sim.getSubject()).toBe(SIMULATED_BANNER);
    expect(sim.getTitle()).toContain("SIMULATED");
    const real = await PDFDocument.load(await renderEvidencePdf({ dispute, draft, folder, simulated: false }));
    expect(real.getSubject() ?? "").not.toContain("SIMULATED");
    expect(real.getTitle()).not.toContain("SIMULATED");
  });
});

describe("sanitize (M2)", () => {
  it("keeps newlines so wrap can split paragraphs, and turns tabs into spaces", () => {
    expect(sanitize("a\tb\r\nc\nd")).toBe("a b\nc\nd");
    expect(sanitize("ok ✓ — done")).toBe("ok  - done");
  });
});
