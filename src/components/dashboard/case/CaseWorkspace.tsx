"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StoredRecommendation } from "@/lib/defense/build-case";
import type { CaseDraft } from "@/lib/defense/case";
import { caseNotes } from "@/lib/defense/notes";
import { offerBlockedReason } from "@/lib/dashboard/view";
import EmptyState from "../EmptyState";
import Icon from "../Icon";
import Panel from "../Panel";
import Skeleton from "../Skeleton";
import CaseActions, { type ActionNotice } from "./CaseActions";
import CaseDraftView from "./CaseDraftView";
import type { EvidenceRoute } from "@/lib/paypal/disputes";
import CoverageChecklist from "./CoverageChecklist";
import RecommendationCard from "./RecommendationCard";

export type BuiltCase = {
  recommendation: StoredRecommendation;
  draft: CaseDraft;
  usedFallback: boolean;
  builtAt: string;
  submittedAt: string | null;
};

export type CaseWorkspaceProps = {
  dispute: {
    id: string;
    amountCents: number;
    currency: string;
    simulated: boolean;
    resolved: boolean;
    evidenceType: string;
    stage: string;
    /** From the last PayPal read of this dispute: how documents can reach PayPal now. */
    evidenceRoute?: EvidenceRoute;
  };
  built: BuiltCase | null;
  priorAction: string | null;
  coverage: { have: string[]; missing: string[]; score: number };
  feeCents: number;
  cooldownSeconds: number;
};

const stampFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const stamp = { format: (d: Date) => `${stampFmt.format(d)} UTC` };

/** Build / review / respond to one dispute. All writes go through the existing dispute API routes. */
export default function CaseWorkspace({ dispute, built, priorAction, coverage, feeCents, cooldownSeconds }: CaseWorkspaceProps) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  // null until mounted, so the server render and hydration agree (no clock reads during render).
  const [now, setNow] = useState<number | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);

  const cooldownEnd = Math.max(built ? new Date(built.builtAt).getTime() + cooldownSeconds * 1000 : 0, retryAt ?? 0);
  const wait = now === null ? 0 : Math.max(0, Math.ceil((cooldownEnd - now) / 1000));

  useEffect(() => {
    if (now === null) {
      setNow(Date.now());
      return;
    }
    if (wait <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wait, now]);

  const done = (n: ActionNotice) => {
    setNotice(n);
    startTransition(() => router.refresh());
  };

  async function build(rebuild: boolean) {
    setBuilding(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(dispute.id)}/case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rebuild ? { rebuild: true } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: number };
      if (res.status === 429) {
        setRetryAt(Date.now() + (body.retryAfterSeconds ?? cooldownSeconds) * 1000);
        setNow(Date.now());
        setNotice({ tone: "error", text: body.error ?? "This case was built moments ago. Try again shortly." });
      } else if (!res.ok) {
        setNotice({ tone: "error", text: body.error ?? "The case could not be built. Try again." });
      } else {
        done({ tone: "success", text: rebuild ? "Case rebuilt from the latest evidence." : "Case built. Review it before sending anything." });
      }
    } catch {
      setNotice({ tone: "error", text: "Network error. Nothing was changed." });
    } finally {
      setBuilding(false);
    }
  }

  const submitted = !!built?.submittedAt;
  const pdfUrl = built ? `/api/disputes/${encodeURIComponent(dispute.id)}/pdf?v=${encodeURIComponent(built.builtAt)}` : null;
  const notes = built ? caseNotes(built.draft) : "";
  const buildButton = built ? (
    <button
      type="button"
      onClick={() => build(true)}
      disabled={building || submitted || wait > 0 || now === null}
      title={submitted ? "Evidence was submitted; the case is final" : undefined}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[#e0d7c3] bg-white px-3 py-1.5 text-sm font-semibold text-green hover:bg-[#f4f7f3] disabled:cursor-not-allowed disabled:opacity-55"
    >
      <Icon name="refresh" className={`h-4 w-4 ${building ? "animate-spin" : ""}`} />
      {building ? "Rebuilding..." : wait > 0 ? `Rebuild in ${wait}s` : "Rebuild"}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => build(false)}
      disabled={building}
      className="inline-flex items-center gap-1.5 rounded-lg bg-green px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#243a2b] disabled:opacity-60"
    >
      <Icon name="sparkles" className="h-4 w-4" />
      {building ? "Building case..." : "Build case"}
    </button>
  );

  return (
    <div className="space-y-6">
      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            notice.tone === "error" ? "border-orange-200 bg-orange-50 text-orange-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          {notice.text}
          {refreshing ? <span className="ml-2 text-xs opacity-70">Updating...</span> : null}
        </div>
      ) : null}
      {submitted ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
          <Icon name="shieldCheck" className="h-4 w-4 shrink-0" />
          {dispute.simulated
            ? `Evidence recorded ${stamp.format(new Date(built!.submittedAt!))} (Simulated dispute: nothing was sent to PayPal).`
            : `Evidence submitted ${stamp.format(new Date(built!.submittedAt!))}. PayPal will review it.`}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Panel
            title="Case draft"
            subtitle={built ? `Built ${stamp.format(new Date(built.builtAt))} · every timeline and argument entry cites evidence from the folder` : "Seller Shield writes the case from your evidence only"}
            actions={built ? buildButton : undefined}
          >
            {building && !built ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : built ? (
              <>
                {built.usedFallback ? (
                  <p className="mb-4 flex items-start gap-2 rounded-lg bg-[#f7f3ea] px-3 py-2 text-xs text-foreground/80">
                    <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" />
                    Used the standard template (AI unavailable or its draft failed the evidence check). Every line still cites real evidence.
                  </p>
                ) : null}
                <CaseDraftView draft={built.draft} evidence={built.recommendation.evidence} />
              </>
            ) : (
              <EmptyState icon="file" title="No case yet" action={buildButton}>
                Build the case to get a recommendation, a source-cited draft and the evidence PDF. Nothing is sent to PayPal.
              </EmptyState>
            )}
          </Panel>

          <Panel
            title="Evidence PDF"
            subtitle="Exactly what Submit evidence attaches"
            actions={
              pdfUrl ? (
                <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-green hover:underline">
                  Open PDF <Icon name="external" className="h-3.5 w-3.5" />
                </a>
              ) : null
            }
            bodyClassName="p-0"
          >
            {pdfUrl ? (
              <iframe key={pdfUrl} src={pdfUrl} title="Evidence PDF preview" className="h-[380px] w-full rounded-b-xl bg-[#f3eee3] sm:h-[520px]" />
            ) : (
              <EmptyState icon="file" title="No PDF yet">The PDF is generated when the case is built.</EmptyState>
            )}
          </Panel>
        </div>

        <div className="order-first min-w-0 space-y-6 lg:order-none">
          {built ? (
            <RecommendationCard rec={built.recommendation} amountCents={dispute.amountCents} feeCents={feeCents} />
          ) : (
            <Panel title="Recommendation">
              <p className="text-sm text-muted">Build the case to compare fighting, offering a partial refund and refunding.</p>
            </Panel>
          )}
          <CoverageChecklist have={coverage.have} missing={coverage.missing} score={coverage.score} />
          <CaseActions
            disputeId={dispute.id}
            simulated={dispute.simulated}
            resolved={dispute.resolved}
            amountCents={dispute.amountCents}
            currency={dispute.currency}
            offerCents={built?.recommendation.offerCents ?? Math.round(dispute.amountCents / 2)}
            offerBlockedReason={offerBlockedReason(dispute.stage)}
            submitBlockedReason={
              !built
                ? "Build the case first."
                : submitted
                  ? "Evidence already submitted."
                  : dispute.evidenceRoute === "none"
                    ? "PayPal is not accepting documents on this dispute right now. Refresh its status from PayPal on the demo guide."
                    : null
            }
            asSupportingInfo={dispute.evidenceRoute === "supporting_info"}
            priorAction={priorAction}
            notesPreview={notes}
            evidenceType={dispute.evidenceType}
            evidenceCount={built?.recommendation.evidence.length ?? 0}
            onDone={done}
          />
        </div>
      </div>
    </div>
  );
}
