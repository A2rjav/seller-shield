"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import SimulatedTag from "../SimulatedTag";

export default function OrderCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      <span className="truncate font-mono text-[12.5px] font-medium text-green" title={data.id}>
        {data.id}
      </span>
      {data.devFixture ? (
        <span>
          <SimulatedTag title="Local dev fixture: this order never existed at PayPal" />
        </span>
      ) : null}
    </div>
  );
}
