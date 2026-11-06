"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { DisputeRow } from "@/lib/dashboard/queries";
import { disputeStatusChip } from "@/lib/dashboard/view";
import Badge from "../Badge";

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function DisputeStatusCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  const chip = disputeStatusChip(data.status);
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1">
      <span>
        <Badge label={chip.label} tone={chip.tone} size="sm" />
      </span>
      <span className="truncate text-xs text-muted">
        {titleCase(data.stage)}
        {data.outcome ? ` · ${titleCase(data.outcome)}` : ""}
      </span>
    </div>
  );
}
