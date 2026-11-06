"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import { disputeStatusChip, reasonLabel } from "@/lib/dashboard/view";
import Badge from "../Badge";

export default function DisputeCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  if (!data.dispute) return <div className="flex h-full items-center text-xs text-muted/70">None</div>;
  const chip = disputeStatusChip(data.dispute.status);
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      <span>
        <Badge label={chip.label} tone={chip.tone} size="sm" />
      </span>
      <span className="truncate text-xs text-muted">
        {reasonLabel(data.dispute.reason)}
        {data.dispute.simulated ? " · Simulated" : ""}
      </span>
    </div>
  );
}
