"use client";

import { useEffect, useState } from "react";
import type { CustomCellRendererProps } from "ag-grid-react";
import type { DisputeRow } from "@/lib/dashboard/queries";
import { dueCountdown, isOpenDispute } from "@/lib/dashboard/view";
import Icon from "../Icon";

const URGENCY = {
  none: "text-muted",
  ok: "text-foreground",
  soon: "text-orange-800 font-semibold",
  overdue: "text-red-700 font-semibold",
} as const;

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Response deadline as a live countdown (updates every minute). */
export default function DueCell({ data }: CustomCellRendererProps<DisputeRow>) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!data) return null;
  if (!isOpenDispute(data.status)) return <div className="flex h-full items-center text-xs text-muted">Closed</div>;
  const c = dueCountdown(data.dueAt, now);
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-0.5">
      <span className={`inline-flex items-center gap-1 text-[13px] ${URGENCY[c.urgency]}`}>
        <Icon name="clock" className="h-3.5 w-3.5" />
        {c.label}
      </span>
      {data.dueAt ? <span className="truncate text-xs text-muted">Due {fmt.format(new Date(data.dueAt))}</span> : null}
    </div>
  );
}
