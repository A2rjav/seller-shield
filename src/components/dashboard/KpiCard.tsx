import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export default function KpiCard({
  label,
  value,
  hint,
  icon,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: IconName;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border p-4 shadow-[0_1px_2px_rgba(38,50,38,0.05)] ${
        emphasis ? "border-orange-200 bg-gradient-to-br from-white to-orange-50/60" : "border-[#e7dfcf] bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${emphasis ? "bg-orange-100 text-orange-700" : "bg-[#eef3ee] text-green"}`}>
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-[28px] ${emphasis ? "text-orange-800" : "text-foreground"}`}>{value}</p>
      {hint ? <p className="mt-1 truncate text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
