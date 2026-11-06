"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";

export default function BuyerCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <span className="truncate font-medium">{data.buyer}</span>
      {data.buyerEmail ? <span className="truncate text-xs text-muted">{data.buyerEmail}</span> : null}
    </div>
  );
}
