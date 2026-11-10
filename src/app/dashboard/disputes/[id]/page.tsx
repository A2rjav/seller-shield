import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import Badge from "@/components/dashboard/Badge";
import CaseWorkspace, { type BuiltCase } from "@/components/dashboard/case/CaseWorkspace";
import Icon from "@/components/dashboard/Icon";
import Panel from "@/components/dashboard/Panel";
import SimulatedTag from "@/components/dashboard/SimulatedTag";
import { db } from "@/lib/db/client";
import { messages } from "@/lib/db/schema";
import { getDisputeDetail } from "@/lib/dashboard/queries";
import { disputeStatusChip, dueCountdown, isCoveredBySellerProtection, isOpenDispute, reasonLabel } from "@/lib/dashboard/view";
import { REBUILD_COOLDOWN_SECONDS, resolveReason, type StoredRecommendation } from "@/lib/defense/build-case";
import type { CaseDraft } from "@/lib/defense/case";
import { DISPUTE_FEE_CENTS } from "@/lib/defense/recommend";
import { buildEvidenceFolder } from "@/lib/evidence/folder";
import { coverage, REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import { formatMoney } from "@/lib/format";
import { getDispute, liveActions, type PaypalDispute } from "@/lib/paypal/disputes";
import { ingestDispute } from "@/lib/disputes/ingest";

const FRESH_READ_MS = 3000;

/** A fresh PayPal read of a real dispute (short timeout), folded into the stored row. Null when PayPal is slow or unreachable. */
async function freshDispute(id: string): Promise<PaypalDispute | null> {
  try {
    const fresh = await Promise.race([
      getDispute(id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), FRESH_READ_MS)),
    ]);
    const t = fresh.update_time ? new Date(fresh.update_time) : new Date();
    await ingestDispute(db, fresh, { eventTime: Number.isNaN(t.getTime()) ? new Date() : t });
    return fresh;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getDisputeDetail(db, id);
  if (!detail) notFound();
  const { caseRow, order } = detail;
  const live = detail.dispute.simulated ? null : await freshDispute(id);
  // Re-read after the ingest so status and stage on the page match PayPal.
  const dispute = live ? ((await getDisputeDetail(db, id))?.dispute ?? detail.dispute) : detail.dispute;

  const reason = resolveReason(dispute.reason);
  const req = REASON_REQUIREMENTS[reason];
  const built: BuiltCase | null =
    caseRow?.draft && caseRow.recommendation
      ? {
          recommendation: caseRow.recommendation as StoredRecommendation,
          draft: caseRow.draft as CaseDraft,
          usedFallback: caseRow.usedFallback,
          builtAt: caseRow.builtAt.toISOString(),
          submittedAt: caseRow.submittedAt?.toISOString() ?? null,
        }
      : null;
  // Before a case is built, show coverage from the live evidence folder (no AI, no PayPal call).
  const cov = built
    ? built.recommendation.coverage
    : coverage(await buildEvidenceFolder(db, { orderId: dispute.orderId, disputeId: dispute.id }), reason);
  const buyerSaid = await db
    .select()
    .from(messages)
    .where(and(eq(messages.disputeId, dispute.id), eq(messages.source, "paypal_dispute")));
  const chip = disputeStatusChip(dispute.status);
  const due = dueCountdown(dispute.sellerResponseDue, new Date());
  const open = isOpenDispute(dispute.status);
  const actions = liveActions(live ?? (dispute.raw as PaypalDispute | null));
  const prior = (caseRow?.submitResult ?? null) as { action?: string } | null;

  return (
    <div className="space-y-6">
      <Link href="/dashboard/disputes" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-green">
        <Icon name="arrowLeft" className="h-4 w-4" /> Disputes
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl tracking-tight text-green sm:text-3xl">{reasonLabel(dispute.reason)}</h1>
            {dispute.simulated ? <SimulatedTag title="Simulated dispute: created by the demo, not by a PayPal buyer" /> : null}
          </div>
          <p className="mt-1 break-all text-sm text-muted">
            <span className="font-mono">{dispute.id}</span>
            {order ? (
              <>
                {" · "}
                <Link href={`/dashboard/orders/${encodeURIComponent(order.id)}`} className="text-green hover:underline">
                  Order {order.id}
                </Link>
                {order.shipName ? ` · ${order.shipName}` : ""}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={chip.label} tone={chip.tone} />
          {open && dispute.sellerResponseDue ? (
            <Badge label={due.label} tone={due.urgency === "ok" ? "gray" : "red"} title={`Respond by ${fmt.format(dispute.sellerResponseDue)} UTC`} />
          ) : null}
          <span className="text-xl font-semibold tabular-nums">{formatMoney(dispute.amountCents, dispute.currency)}</span>
        </div>
      </div>

      <Panel title="What the buyer is claiming">
        <p className="text-sm text-foreground/85">{req.plain}</p>
        {!isCoveredBySellerProtection(dispute.reason) ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-semibold">Not covered by Seller Protection.</span> PayPal Seller Protection covers only item-not-received and unauthorized-payment
              claims, so this one is decided on your evidence alone.
            </span>
          </p>
        ) : null}
        {buyerSaid.length ? (
          <div className="mt-3 space-y-2">
            {buyerSaid.map((m) => (
              <blockquote key={m.id} className="rounded-lg border-l-4 border-[#e2d9c6] bg-[#fbf8f2] px-3 py-2 text-sm">
                <span className="text-foreground/85">&ldquo;{m.body}&rdquo;</span>
                <span className="mt-1 block text-xs text-muted">
                  {m.author === "buyer" ? "Buyer" : m.author === "seller" ? "You" : "PayPal"}, {fmt.format(m.createdAt)} UTC
                  {dispute.simulated ? " · Simulated" : ""}
                </span>
              </blockquote>
            ))}
          </div>
        ) : null}
      </Panel>

      <CaseWorkspace
        dispute={{
          id: dispute.id,
          amountCents: dispute.amountCents,
          currency: dispute.currency,
          simulated: dispute.simulated,
          resolved: !open,
          evidenceType: req.paypalEvidenceType,
          stage: dispute.stage,
          evidenceRoute: dispute.simulated ? "evidence" : actions.evidenceRoute,
          acceptBlockedReason: dispute.simulated ? null : actions.acceptBlockedReason,
        }}
        built={built}
        priorAction={prior?.action ?? null}
        coverage={cov}
        feeCents={DISPUTE_FEE_CENTS}
        cooldownSeconds={REBUILD_COOLDOWN_SECONDS}
      />
    </div>
  );
}
