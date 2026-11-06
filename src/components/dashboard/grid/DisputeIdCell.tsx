"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { DisputeRow } from "@/lib/dashboard/queries";
import SimulatedTag from "../SimulatedTag";

export default function DisputeIdCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1">
      <span className="truncate font-mono text-[12.5px] font-medium text-green" title={data.id}>
        {data.id}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        {data.orderId ? <span className="truncate">Order {data.orderId}</span> : <span>No linked order</span>}
        {data.simulated ? <SimulatedTag title="Simulated dispute: created by the demo, not by a PayPal buyer" /> : null}
      </span>
    </div>
  );
}
