"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import AgentBadge from "../AgentBadge";

export default function SourceCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center">
      {data.source === "agent" ? (
        <AgentBadge state={data.mandate ?? "not_checked"} compact />
      ) : (
        <span className="text-[13px] text-muted">Storefront</span>
      )}
    </div>
  );
}
