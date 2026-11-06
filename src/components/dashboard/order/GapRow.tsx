import type { ReactNode } from "react";
import type { Gap } from "@/lib/protection/rules";
import { GAP_TITLE } from "@/lib/dashboard/view";
import BasisChip from "../BasisChip";
import Icon from "../Icon";
import Skeleton from "../Skeleton";

/** One protection gap: what it is, where the rule comes from, a plain-language line and its fix. */
export default function GapRow({
  gap,
  line,
  lineFromAi,
  loadingLine,
  children,
}: {
  gap: Gap;
  line: string | null;
  lineFromAi: boolean;
  loadingLine: boolean;
  children?: ReactNode;
}) {
  const high = gap.severity === "high";
  return (
    <li className="flex gap-3 py-4 first:pt-0 last:pb-0">
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${high ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-800"}`}
        title={high ? "High severity" : "Medium severity"}
      >
        <Icon name={high ? "alert" : "clock"} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">{GAP_TITLE[gap.code]}</p>
          <span className={`text-[11px] font-medium ${high ? "text-orange-800" : "text-amber-800"}`}>{high ? "High" : "Medium"}</span>
          <BasisChip basis={gap.basis} />
        </div>
        {loadingLine && !line ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ) : line ? (
          <p className="mt-1 text-sm text-foreground/80">
            {lineFromAi ? <Icon name="sparkles" className="mr-1 inline h-3.5 w-3.5 -translate-y-px text-accent" title="Written by AI from the order facts" /> : null}
            {line}
          </p>
        ) : null}
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
    </li>
  );
}
