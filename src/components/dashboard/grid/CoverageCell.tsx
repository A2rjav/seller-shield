"use client";

import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import CoverageBar from "../CoverageBar";

const NAMES: Record<string, string> = {
  capture: "payment capture",
  ship_address: "PayPal ship address",
  tracking: "tracking",
  delivery: "delivery",
  mandate: "purchase mandate",
  payer_approval: "payer approval",
};

export default function CoverageCell({ data }: CustomCellRendererProps<OrderRow>) {
  if (!data) return null;
  const missing = data.coverage.missing.map((k) => NAMES[k] ?? k);
  const title = missing.length ? `Missing: ${missing.join(", ")}` : "All core proof on file";
  return (
    <div className="flex h-full items-center">
      <CoverageBar score={data.coverage.score} title={title} />
    </div>
  );
}
