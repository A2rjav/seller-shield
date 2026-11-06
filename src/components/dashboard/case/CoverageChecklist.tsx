import { evidenceKindLabel } from "@/lib/dashboard/view";
import CoverageBar from "../CoverageBar";
import Icon from "../Icon";
import Panel from "../Panel";

/** The evidence this dispute reason needs: what is on file and what is missing. */
export default function CoverageChecklist({ have, missing, score }: { have: string[]; missing: string[]; score: number }) {
  const total = have.length + missing.length;
  return (
    <Panel title="Evidence checklist" subtitle={total ? `${have.length} of ${total} items this reason needs` : "This reason has no fixed checklist"}>
      <CoverageBar score={score} />
      {total ? (
        <ul className="mt-4 space-y-2 text-sm">
          {have.map((k) => (
            <li key={k} className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Icon name="check" className="h-3.5 w-3.5" />
              </span>
              <span>{evidenceKindLabel(k)}</span>
              <span className="sr-only">(on file)</span>
            </li>
          ))}
          {missing.map((k) => (
            <li key={k} className="flex items-center gap-2 text-foreground/70">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-700">
                <Icon name="x" className="h-3.5 w-3.5" />
              </span>
              <span>{evidenceKindLabel(k)}</span>
              <span className="ml-auto text-[11px] font-medium text-orange-800">Missing</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
