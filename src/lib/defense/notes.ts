// Client-safe (no server imports): used by the case UI preview and by the PayPal submission.
import type { CaseDraft } from "./case";

/** The one claim about citations every surface (PDF, UI, demo guide) makes. */
export const CITATION_CLAIM = "Every timeline and argument entry cites the evidence item ids";

export const NOTES_MAX = 2000;

/** The notes sent to PayPal: the deterministic summary plus each validated entry with its evidence ids, cut at whole lines. */
export function caseNotes(draft: CaseDraft, max = NOTES_MAX): string {
  const lines = [
    draft.summary,
    ...(draft.timeline.length ? ["", "Timeline:"] : []),
    ...draft.timeline.map((e) => `- ${e.at ? `${e.at.slice(0, 10)} ` : ""}${e.text} [${e.evidenceIds.join(", ")}]`),
    ...(draft.argument.length ? ["", "Why this answers the claim:"] : []),
    ...draft.argument.map((a) => `- ${a.text} [${a.evidenceIds.join(", ")}]`),
  ];
  let out = "";
  for (const l of lines) {
    const next = out ? `${out}\n${l}` : l;
    if (next.length > max) break;
    out = next;
  }
  return out.trim() || "Evidence attached.";
}
