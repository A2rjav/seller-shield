"use client";

import Link from "next/link";
import { useState } from "react";
import type { CustomCellRendererProps } from "ag-grid-react";
import type { OrderRow } from "@/lib/dashboard/queries";
import Icon from "../Icon";

export type OrdersGridContext = {
  onChanged: () => void;
  notify: (n: { tone: "success" | "error"; text: string }) => void;
};

const linkCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[#e0d7c3] bg-white px-2.5 py-1 text-xs font-semibold text-green hover:border-green/40 hover:bg-[#f4f7f3]";

/** "Fix" pushes tracking to PayPal in one click; other gaps link to the order's protection panel. */
export default function ActionsCell({ data, context }: CustomCellRendererProps<OrderRow, unknown, OrdersGridContext>) {
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const href = `/dashboard/orders/${encodeURIComponent(data.id)}`;

  async function pushTracking() {
    if (!data) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(data.id)}/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ push: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; simulated?: boolean };
      if (!res.ok) {
        context.notify({ tone: "error", text: body.error ?? "Could not push tracking to PayPal." });
      } else {
        context.notify({
          tone: "success",
          text: `Tracking for ${data.id} ${body.simulated ? "recorded (Simulated push: local dev order, not sent to PayPal)" : "is now on PayPal"}.`,
        });
      }
      context.onChanged();
    } catch {
      context.notify({ tone: "error", text: "Network error. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  let action: React.ReactNode;
  if (data.fix === "push_tracking") {
    action = (
      <button
        type="button"
        onClick={pushTracking}
        disabled={busy}
        title="Send this order's tracking number to PayPal"
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-green px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#243a2b] disabled:opacity-60"
      >
        {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : <Icon name="upload" className="h-3.5 w-3.5" />}
        {busy ? "Pushing" : "Fix"}
      </button>
    );
  } else if (!data.hasShipment && data.status !== "not_eligible") {
    action = (
      <Link href={`${href}#protection`} className={linkCls}>
        Add tracking
      </Link>
    );
  } else if (data.fix === "ship_to_paypal_address") {
    action = (
      <Link href={`${href}#protection`} className={linkCls}>
        Review
      </Link>
    );
  } else {
    action = (
      <Link href={href} className="inline-flex items-center gap-0.5 text-xs font-medium text-muted hover:text-green" aria-label={`Open order ${data.id}`}>
        Open <Icon name="chevronRight" className="h-3.5 w-3.5" />
      </Link>
    );
  }
  return (
    <div className="flex h-full items-center" data-no-row-click>
      {action}
    </div>
  );
}
