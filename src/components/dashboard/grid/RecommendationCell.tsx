"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { DisputeRow } from "@/lib/dashboard/queries";
import Badge from "../Badge";

const ACTION = {
  fight: { label: "Fight with evidence", tone: "green" },
  offer: { label: "Offer partial refund", tone: "amber" },
  refund: { label: "Refund", tone: "gray" },
} as const;

export default function RecommendationCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  const caseText = data.caseState === "submitted" ? "Evidence submitted" : data.caseState === "built" ? "Case ready to review" : "No case yet";
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1">
      <span>
        {data.recommendation ? (
          <Badge label={ACTION[data.recommendation].label} tone={ACTION[data.recommendation].tone} size="sm" />
        ) : (
          <span className="text-xs font-medium text-green">Build case to see</span>
        )}
      </span>
      <span className="truncate text-xs text-muted">{caseText}</span>
    </div>
  );
}
