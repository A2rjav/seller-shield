import { percent } from "@/lib/dashboard/view";

/** Evidence coverage as a bar plus the percentage in text. */
export default function CoverageBar({ score, title }: { score: number; title?: string }) {
  const tone = score >= 0.99 ? "bg-emerald-600" : score >= 0.6 ? "bg-amber-500" : "bg-orange-600";
  return (
    <div className="flex w-full min-w-0 items-center gap-2" title={title}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#efe8da]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(score * 100)}
        aria-label="Evidence coverage"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, Math.round(score * 100))}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted">{percent(score)}</span>
    </div>
  );
}
