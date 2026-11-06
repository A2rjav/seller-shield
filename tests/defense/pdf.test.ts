import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderEvidencePdf } from "@/lib/defense/pdf";
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
