"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { gridTheme } from "@/components/dashboard/grid/gridSetup";
import DisputeIdCell from "@/components/dashboard/grid/DisputeIdCell";
import DisputeStatusCell from "@/components/dashboard/grid/DisputeStatusCell";
import DueCell from "@/components/dashboard/grid/DueCell";
import GridOverlay, { type GridOverlayParams } from "@/components/dashboard/grid/GridOverlay";
import RecommendationCell from "@/components/dashboard/grid/RecommendationCell";
import Icon from "@/components/dashboard/Icon";
import type { DisputeRow } from "@/lib/dashboard/queries";
import { disputeStatusChip } from "@/lib/dashboard/view";
import { formatMoney } from "@/lib/format";

const overlayParams: GridOverlayParams = {
  emptyTitle: "No disputes",
  emptyText: "Nothing to answer. New PayPal disputes arrive by webhook, or use Refresh from PayPal.",
  noMatchText: "No disputes match your search.",
  loadingText: "Checking PayPal...",
};

function OpenCaseCell() {
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-green">
      Open case <Icon name="chevronRight" className="h-3.5 w-3.5" />
    </span>
  );
}

export default function DisputesGrid({ rows, loading }: { rows: DisputeRow[]; loading: boolean }) {
  const router = useRouter();
  const [quick, setQuick] = useState("");

  const columnDefs = useMemo<ColDef<DisputeRow>[]>(
    () => [
      { field: "id", headerName: "Dispute", cellRenderer: DisputeIdCell, minWidth: 200, flex: 1.2 },
      {
        field: "reasonLabel",
        headerName: "Reason",
        minWidth: 170,
        flex: 1,
        cellClass: "ss-cell font-medium",
      },
      {
        field: "amountCents",
        headerName: "Amount",
        width: 110,
        type: "rightAligned",
        cellClass: "ss-cell ss-right tabular-nums font-medium",
        valueFormatter: (p) => (p.data ? formatMoney(p.data.amountCents, p.data.currency) : ""),
      },
      {
        field: "dueAt",
        headerName: "Respond by",
        cellRenderer: DueCell,
        width: 170,
        sort: "asc",
        comparator: (a: string | null, b: string | null) => (a ? new Date(a).getTime() : Infinity) - (b ? new Date(b).getTime() : Infinity),
      },
      {
        field: "recommendation",
        headerName: "Recommendation",
        cellRenderer: RecommendationCell,
        width: 200,
        getQuickFilterText: (p) => `${p.data?.recommendation ?? ""} ${p.data?.caseState ?? ""}`,
      },
      {
        field: "status",
        headerName: "Status",
        cellRenderer: DisputeStatusCell,
        width: 190,
        getQuickFilterText: (p) => (p.data ? `${disputeStatusChip(p.data.status).label} ${p.data.stage}` : ""),
      },
      {
        colId: "open",
        headerName: "",
        width: 96,
        sortable: false,
        cellRenderer: OpenCaseCell,
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (e: RowClickedEvent<DisputeRow>) => {
      if (e.data) router.push(`/dashboard/disputes/${encodeURIComponent(e.data.id)}`);
    },
    [router],
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#efe8da] px-4 py-3 sm:px-5">
        <label className="relative min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
          <span className="sr-only">Search disputes</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Search dispute, order, reason..."
            className="w-full rounded-lg border border-[#e0d7c3] bg-[#fdfbf6] py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-muted/70 focus:border-green/50 focus:bg-white focus:ring-2 focus:ring-green/15"
          />
        </label>
        <span className="ml-auto text-xs text-muted">Soonest deadline first</span>
      </div>
      <div className="w-full">
        <AgGridReact<DisputeRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true, cellClass: "ss-cell" }}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
          loading={loading}
          overlayComponent={GridOverlay}
          overlayComponentParams={overlayParams}
          onRowClicked={onRowClicked}
          rowClass="cursor-pointer"
          domLayout="autoHeight"
          animateRows
        />
      </div>
    </div>
  );
}
