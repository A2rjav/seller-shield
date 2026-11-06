"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import { GAP_TITLE, protectionBadge } from "@/lib/dashboard/view";
import Badge from "../Badge";

export default function ProtectionCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  const b = protectionBadge(data.status);
  const first = data.gaps[0];
  const more = data.gaps.length - 1;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      <span>
        <Badge label={b.label} tone={b.tone} size="sm" />
      </span>
      {first ? (
        <span className="truncate text-xs text-muted" title={data.firstGapText ?? undefined}>
          {GAP_TITLE[first.code]}
          {more > 0 ? <span className="text-muted/80"> +{more} more</span> : null}
        </span>
      ) : data.status === "protected" ? (
        <span className="truncate text-xs text-muted">All requirements met</span>
      ) : null}
    </div>
  );
}
