import type { CaseDraft } from "@/lib/defense/case";
import type { EvidenceItem } from "@/lib/evidence/folder";
import EvidenceChip from "./EvidenceChip";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtAt = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : day.format(d);
};

/** The case draft. Every timeline line and argument sentence carries chips for the evidence it cites. */
export default function CaseDraftView({ draft, evidence }: { draft: CaseDraft; evidence: EvidenceItem[] }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const index = new Map(evidence.map((e, i) => [e.id, i]));
  const chips = (ids: string[]) => ids.map((id) => <EvidenceChip key={id} id={id} item={byId.get(id)} n={(index.get(id) ?? -1) + 1} />);
  return (
    <div className="space-y-6 text-sm leading-relaxed [overflow-wrap:anywhere]">
      {draft.summary ? <p className="text-foreground/85">{draft.summary}</p> : null}

      {draft.timeline.length ? (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Timeline</h3>
          <ol className="mt-2 space-y-2.5 border-l-2 border-[#ece5d6] pl-4">
            {draft.timeline.map((t, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-2 h-2 w-2 rounded-full bg-green" aria-hidden />
                <span className="mr-2 text-xs font-semibold tabular-nums text-muted">{fmtAt(t.at)}</span>
                <span>{t.text}</span>
                {chips(t.evidenceIds)}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {draft.argument.length ? (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Why the seller should win</h3>
          <ul className="mt-2 space-y-2.5">
            {draft.argument.map((a, i) => (
              <li key={i} className="rounded-lg bg-[#fbf8f2] px-3 py-2">
                <span>{a.text}</span>
                {chips(a.evidenceIds)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

    </div>
  );
}
