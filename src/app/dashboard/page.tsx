import Link from "next/link";
import Badge from "@/components/dashboard/Badge";
import KpiCard from "@/components/dashboard/KpiCard";
import Panel from "@/components/dashboard/Panel";
import { db } from "@/lib/db/client";
import { disputes } from "@/lib/db/schema";
import { listOrderRows } from "@/lib/dashboard/queries";
import { dashboardKpis } from "@/lib/dashboard/summary";
import { protectionBadge } from "@/lib/dashboard/view";
import { formatMoney } from "@/lib/format";
import OrdersGrid from "./OrdersGrid";

export const dynamic = "force-dynamic";

const LEGEND = [
  { status: "protected", text: "meets PayPal Seller Protection requirements" },
  { status: "pending", text: "on track, waiting on delivery or a small fix" },
  { status: "at_risk", text: "a gap that can lose a dispute" },
  { status: "not_eligible", text: "outside Seller Protection (e.g. over $10,000)" },
] as const;

export default async function OrdersDashboard() {
  const [rows, ds] = await Promise.all([
    listOrderRows(db),
    db.select({ orderId: disputes.orderId, amountCents: disputes.amountCents, status: disputes.status }).from(disputes),
  ]);
  const k = dashboardKpis(rows, ds);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-green sm:text-3xl">Orders</h1>
          <p className="mt-1 text-sm text-muted">Seller Protection readiness for every order, and one-click fixes for the gaps.</p>
        </div>
        <Link href="/dashboard/disputes" className="inline-flex items-center gap-1.5 text-sm font-medium text-green hover:underline">
          Go to disputes &rarr;
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Money at risk"
          icon="alert"
          emphasis={k.moneyAtRiskCents > 0}
          value={formatMoney(k.moneyAtRiskCents)}
          hint="At-risk orders + open disputes"
        />
        <KpiCard
          label="Protected"
          icon="shieldCheck"
          value={k.protectedPct === null ? "-" : `${k.protectedPct}%`}
          hint={`${rows.filter((r) => r.status === "protected").length} of ${k.totalOrders} orders`}
        />
        <KpiCard
          label="Open disputes"
          icon="inbox"
          value={k.openDisputes}
          hint={k.openDisputes ? <Link href="/dashboard/disputes" className="hover:underline">Review and respond &rarr;</Link> : "Nothing to answer"}
        />
        <KpiCard label="Agent orders" icon="bot" value={k.agentOrders} hint="Placed by AI shopping agents" />
      </div>

      <Panel title="All orders" subtitle="Click a row for its evidence timeline and protection details." bodyClassName="p-0">
        <OrdersGrid rows={rows} />
      </Panel>

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted" aria-label="Status legend">
        {LEGEND.map((l) => {
          const b = protectionBadge(l.status);
          return (
            <li key={l.status} className="flex items-center gap-2">
              <Badge label={b.label} tone={b.tone} size="sm" />
              {l.text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
