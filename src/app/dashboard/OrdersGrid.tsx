"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, IRowNode, RowClickedEvent } from "ag-grid-community";
import { gridTheme } from "@/components/dashboard/grid/gridSetup";
import ActionsCell, { type OrdersGridContext } from "@/components/dashboard/grid/ActionsCell";
import BuyerCell from "@/components/dashboard/grid/BuyerCell";
import CoverageCell from "@/components/dashboard/grid/CoverageCell";
import DisputeCell from "@/components/dashboard/grid/DisputeCell";
import GridOverlay, { type GridOverlayParams } from "@/components/dashboard/grid/GridOverlay";
import OrderCell from "@/components/dashboard/grid/OrderCell";
import ProtectionCell from "@/components/dashboard/grid/ProtectionCell";
import SourceCell from "@/components/dashboard/grid/SourceCell";
import Icon from "@/components/dashboard/Icon";
import type { OrderRow } from "@/lib/dashboard/queries";
import { GAP_TITLE, protectionBadge, reasonLabel } from "@/lib/dashboard/view";
import { formatMoney } from "@/lib/format";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const STATUS_ORDER = { at_risk: 0, pending: 1, not_eligible: 2, protected: 3 } as const;

const overlayParams: GridOverlayParams = {
  emptyTitle: "No orders yet",
  emptyText: "Orders appear here as soon as a buyer or an AI agent checks out in the Juniper & Thread store.",
  noMatchText: "No orders match. Clear the search or turn off \"At risk only\".",
  loadingText: "Refreshing orders...",
};

export default function OrdersGrid({ rows }: { rows: OrderRow[] }) {
  const router = useRouter();
  const apiRef = useRef<GridApi<OrderRow> | null>(null);
  const [quick, setQuick] = useState("");
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const [shown, setShown] = useState(rows.length);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const context = useMemo<OrdersGridContext>(() => ({ onChanged: refresh, notify: setNotice }), [refresh]);

  const columnDefs = useMemo<ColDef<OrderRow>[]>(
    () => [
      { field: "id", headerName: "Order", cellRenderer: OrderCell, width: 140 },
      {
        field: "createdAt",
        headerName: "Date",
        width: 104,
        sort: "desc",
        valueFormatter: (p) => (p.value ? dateFmt.format(new Date(p.value)) : ""),
        getQuickFilterText: (p) => (p.value ? dateFmt.format(new Date(p.value)) : ""),
      },
      {
        field: "buyer",
        headerName: "Buyer",
        cellRenderer: BuyerCell,
        minWidth: 140,
        flex: 1,
        getQuickFilterText: (p) => `${p.data?.buyer ?? ""} ${p.data?.buyerEmail ?? ""}`,
      },
      {
        field: "amountCents",
        headerName: "Amount",
        width: 100,
        type: "rightAligned",
        cellClass: "ss-cell ss-right tabular-nums font-medium",
        valueFormatter: (p) => (p.data ? formatMoney(p.data.amountCents, p.data.currency) : ""),
      },
      {
        field: "source",
        headerName: "Source",
        cellRenderer: SourceCell,
        width: 146,
        getQuickFilterText: (p) => (p.data?.source === "agent" ? `agent mandate ${p.data.mandate ?? ""}` : "storefront human"),
      },
      {
        colId: "protection",
        headerName: "Protection",
        cellRenderer: ProtectionCell,
        minWidth: 190,
        flex: 1.4,
        valueGetter: (p) => (p.data?.status ? STATUS_ORDER[p.data.status] : 9),
        getQuickFilterText: (p) =>
          p.data ? `${protectionBadge(p.data.status).label} ${p.data.gaps.map((g) => GAP_TITLE[g.code]).join(" ")}` : "",
      },
      {
        colId: "coverage",
        headerName: "Evidence",
        headerTooltip: "Proof on file: payment, PayPal ship address, tracking, delivery (plus the mandate for agent orders)",
        cellRenderer: CoverageCell,
        width: 116,
        valueGetter: (p) => p.data?.coverage.score ?? 0,
        getQuickFilterText: () => "",
      },
      {
        colId: "dispute",
        headerName: "Dispute",
        cellRenderer: DisputeCell,
        width: 168,
        valueGetter: (p) => p.data?.dispute?.status ?? "",
        getQuickFilterText: (p) => (p.data?.dispute ? `dispute ${reasonLabel(p.data.dispute.reason)}` : ""),
      },
      { colId: "actions", headerName: "", cellRenderer: ActionsCell, width: 108, sortable: false, getQuickFilterText: () => "" },
    ],
    [],
  );

  const isExternalFilterPresent = useCallback(() => atRiskOnly, [atRiskOnly]);
  const doesExternalFilterPass = useCallback((node: IRowNode<OrderRow>) => node.data?.status === "at_risk", []);

  useEffect(() => {
    apiRef.current?.onFilterChanged();
  }, [atRiskOnly]);

  const onRowClicked = useCallback(
    (e: RowClickedEvent<OrderRow>) => {
      const target = e.event?.target as HTMLElement | null;
      if (target?.closest("[data-no-row-click], a, button")) return;
      if (e.data) router.push(`/dashboard/orders/${encodeURIComponent(e.data.id)}`);
    },
    [router],
  );

  const atRiskCount = rows.filter((r) => r.status === "at_risk").length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#efe8da] px-4 py-3 sm:px-5">
        <label className="relative min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
          <span className="sr-only">Search orders</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Search order, buyer, gap..."
            className="w-full rounded-lg border border-[#e0d7c3] bg-[#fdfbf6] py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-muted/70 focus:border-green/50 focus:bg-white focus:ring-2 focus:ring-green/15"
          />
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={atRiskOnly}
          onClick={() => setAtRiskOnly((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-medium text-foreground"
        >
          <span className={`relative h-5 w-9 rounded-full transition-colors ${atRiskOnly ? "bg-orange-600" : "bg-[#ddd4c1]"}`} aria-hidden>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${atRiskOnly ? "left-[18px]" : "left-0.5"}`} />
          </span>
          At risk only
          <span className="rounded-full bg-orange-50 px-1.5 text-xs font-semibold text-orange-800 ring-1 ring-inset ring-orange-700/20">{atRiskCount}</span>
        </button>
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {pending ? "Refreshing..." : `${shown} of ${rows.length} orders`}
        </span>
      </div>
      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 border-b px-4 py-2 text-sm sm:px-5 ${
            notice.tone === "error" ? "border-orange-200 bg-orange-50 text-orange-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="w-full">
        <AgGridReact<OrderRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true, cellClass: "ss-cell" }}
          getRowId={(p) => p.data.id}
          context={context}
          quickFilterText={quick}
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={doesExternalFilterPass}
          loading={pending}
          overlayComponent={GridOverlay}
          overlayComponentParams={overlayParams}
          onGridReady={(e) => {
            apiRef.current = e.api;
          }}
          onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
          onRowClicked={onRowClicked}
          rowClass="cursor-pointer"
          domLayout="autoHeight"
          pagination={rows.length > 20}
          paginationPageSize={20}
          paginationPageSizeSelector={[20, 50, 100]}
          tooltipShowDelay={300}
          animateRows
        />
      </div>
    </div>
  );
}
