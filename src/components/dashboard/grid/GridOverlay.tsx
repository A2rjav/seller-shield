"use client";

import type { IOverlayParams } from "ag-grid-community";

export type GridOverlayParams = {
  /** Shown when the grid has no rows at all. */
  emptyTitle: string;
  emptyText: string;
  /** Shown when filters hide every row. */
  noMatchText?: string;
  loadingText?: string;
};

/** One overlay component for the grid-provided overlays (AG Grid 36 `overlayComponent`). */
export default function GridOverlay(props: IOverlayParams & GridOverlayParams) {
  if (props.overlayType === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-white/95 px-4 py-2 text-sm text-muted shadow-sm ring-1 ring-[#e7dfcf]" role="status">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#d9d0bd] border-t-green" aria-hidden />
        {props.loadingText ?? "Loading..."}
      </div>
    );
  }
  if (props.overlayType === "noMatchingRows") {
    return (
      <div className="max-w-xs text-center text-sm text-muted" role="status">
        <p className="font-semibold text-foreground">No matches</p>
        <p className="mt-1">{props.noMatchText ?? "No rows match your filters."}</p>
      </div>
    );
  }
  return (
    <div className="max-w-xs text-center text-sm text-muted" role="status">
      <p className="font-semibold text-foreground">{props.emptyTitle}</p>
      <p className="mt-1">{props.emptyText}</p>
    </div>
  );
}
