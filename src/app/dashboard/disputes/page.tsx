import KpiCard from "@/components/dashboard/KpiCard";
import { db } from "@/lib/db/client";
import { listDisputeRows } from "@/lib/dashboard/queries";
import { dueCountdown, isOpenDispute } from "@/lib/dashboard/view";
import { formatMoney } from "@/lib/format";
import DisputesInbox from "./DisputesInbox";

export const dynamic = "force-dynamic";

export default async function DisputesPage() {
  const rows = await listDisputeRows(db);
  const open = rows.filter((r) => isOpenDispute(r.status));
  const now = new Date();
  const urgent = open.filter((r) => ["soon", "overdue"].includes(dueCountdown(r.dueAt, now).urgency)).length;
  const ready = open.filter((r) => r.caseState === "built").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-green sm:text-3xl">Disputes</h1>
        <p className="mt-1 text-sm text-muted">
          Each dispute gets an evidence-backed case. Nothing is sent to PayPal until you review it and confirm.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Open" icon="inbox" value={open.length} hint={`${rows.length} in total`} />
        <KpiCard label="In dispute" icon="dollar" emphasis={open.length > 0} value={formatMoney(open.reduce((s, r) => s + r.amountCents, 0))} hint="Across open disputes" />
        <KpiCard label="Due in 48h" icon="clock" value={urgent} hint={urgent ? "Respond first" : "No deadlines this close"} />
        <KpiCard label="Cases ready" icon="file" value={ready} hint="Built and waiting for your review" />
      </div>
      <DisputesInbox rows={rows} initialPoll={null} />
    </div>
  );
}
