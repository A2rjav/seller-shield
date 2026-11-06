import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CaseDraft } from "./case";
import type { EvidenceItem } from "@/lib/evidence/folder";
import { REASON_REQUIREMENTS, type PaypalReason } from "@/lib/evidence/requirements";

type DisputeLike = { dispute_id: string; reason: string; dispute_amount: { currency_code: string; value: string } };

const SUBS: [RegExp, string][] = [
  [/[–—−]/g, "-"],
  [/[‘’‚]/g, "'"],
  [/[“”„]/g, '"'],
  [/…/g, "..."],
  [/[   ]/g, " "],
];

/** Standard fonts only encode WinAnsi; map common punctuation and drop whatever else cannot be encoded. */
export function sanitize(s: string): string {
  let out = s;
  for (const [re, to] of SUBS) out = out.replace(re, to);
  return out.replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

/** One timeline/argument row with its citations; rows that cite a simulated item carry a [SIMULATED] marker. */
export function formatRow(text: string, ids: string[], byId: Map<string, EvidenceItem>, at?: string): string {
  const sim = ids.some((id) => byId.get(id)?.simulated);
  return `${at ? at.slice(0, 10) + "  " : ""}${text}  [${ids.join(", ")}]${sim ? " [SIMULATED]" : ""}`;
}

const W = 612, H = 792, M = 54, LH = 14;

export async function renderEvidencePdf(input: {
  dispute: DisputeLike;
  draft: CaseDraft;
  folder: EvidenceItem[];
  shopName?: string;
  generatedAt?: Date;
}): Promise<Uint8Array> {
  const { dispute, draft, folder } = input;
  const doc = await PDFDocument.create();
  doc.setTitle(sanitize(`Seller Shield evidence pack - ${dispute.dispute_id}`));
  doc.setProducer("Seller Shield");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const byId = new Map(folder.map((i) => [i.id, i]));

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };

  const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
    const lines: string[] = [];
    for (const para of sanitize(text).split(/\r?\n/)) {
      let cur = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        // Break words longer than a line.
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) {
          let n = w.length - 1;
          while (n > 1 && f.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          if (cur) { lines.push(cur); cur = ""; }
          lines.push(w.slice(0, n));
          w = w.slice(n);
        }
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) <= width) cur = next;
        else { lines.push(cur); cur = w; }
      }
      lines.push(cur);
    }
    return lines;
  };

  const write = (text: string, o: { f?: PDFFont; size?: number; indent?: number; color?: [number, number, number] } = {}) => {
    const f = o.f ?? font, size = o.size ?? 10, indent = o.indent ?? 0;
    for (const l of wrap(text, f, size, W - 2 * M - indent)) {
      if (y < M + LH) newPage();
      page.drawText(l, { x: M + indent, y, size, font: f, color: rgb(...(o.color ?? [0.1, 0.1, 0.1])) });
      y -= Math.max(LH, size + 3);
    }
  };
  const gap = (n = LH) => { y -= n; };

  // ---- Cover ----
  const reasonPlain = REASON_REQUIREMENTS[dispute.reason as PaypalReason]?.plain ?? dispute.reason;
  write(input.shopName ?? "Juniper & Thread", { f: bold, size: 22 });
  gap(6);
  write("Dispute evidence pack", { f: bold, size: 16 });
  gap(18);
  write(`Dispute ID: ${dispute.dispute_id}`, { size: 12 });
  write(`Reason: ${dispute.reason}`, { size: 12 });
  write(reasonPlain, { size: 10, indent: 12 });
  write(`Amount: ${dispute.dispute_amount.value} ${dispute.dispute_amount.currency_code}`, { size: 12 });
  write(`Generated: ${(input.generatedAt ?? new Date()).toISOString().slice(0, 10)}`, { size: 12 });
  gap();
  if (draft.summary) write(draft.summary);
  gap();
  write("Every statement in this pack cites the evidence item ids shown in brackets. Items marked SIMULATED come from a demo carrier or simulation, not from a real carrier or PayPal record.", { size: 9, color: [0.4, 0.4, 0.4] });

  // ---- Timeline ----
  newPage();
  write("Timeline", { f: bold, size: 16 });
  gap(6);
  for (const e of draft.timeline) {
    write(formatRow(e.text, e.evidenceIds, byId, e.at));
    gap(4);
  }
  if (draft.argument.length) {
    gap();
    write("Why this answers the claim", { f: bold, size: 14 });
    gap(4);
    for (const a of draft.argument) {
      write(formatRow(a.text, a.evidenceIds, byId));
      gap(4);
    }
  }
  if (draft.sellerNote) {
    gap();
    write("Seller note", { f: bold, size: 12 });
    write(draft.sellerNote);
  }

  // ---- One section per cited item ----
  const cited = [...new Set([...draft.timeline, ...draft.argument].flatMap((e) => e.evidenceIds))]
    .map((id) => byId.get(id))
    .filter((i): i is EvidenceItem => !!i);
  if (cited.length) {
    newPage();
    write("Evidence items", { f: bold, size: 16 });
    gap(8);
  }
  for (const i of cited) {
    if (y < M + 90) newPage();
    write(`${i.title}${i.simulated ? "   SIMULATED" : ""}`, { f: bold, size: 12, color: i.simulated ? [0.7, 0.3, 0] : [0.1, 0.1, 0.1] });
    write(`Evidence id: ${i.id}`, { size: 9, indent: 8, color: [0.4, 0.4, 0.4] });
    write(`Source: ${i.source}${i.at ? `   Date: ${i.at.slice(0, 10)}` : ""}`, { size: 9, indent: 8, color: [0.4, 0.4, 0.4] });
    write(i.summary, { indent: 8 });
    if (i.kind === "mandate") {
      const d = (i.data ?? {}) as { hash?: unknown; verified?: unknown };
      write(`Mandate hash: ${typeof d.hash === "string" ? d.hash : "not recorded"}`, { indent: 8 });
      write(`Signature verification: ${d.verified === true ? "verified" : "not verified"}`, { indent: 8 });
    }
    gap(10);
  }

  return doc.save();
}
