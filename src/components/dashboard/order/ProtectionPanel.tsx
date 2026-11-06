"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GapCode, ProtectionResult } from "@/lib/protection/rules";
import { protectionBadge } from "@/lib/dashboard/view";
import Badge from "../Badge";
import Icon from "../Icon";
import Panel from "../Panel";
import GapRow from "./GapRow";
import TrackingForm from "./TrackingForm";

type Explanation = { lines: { code: GapCode; text: string }[]; usedFallback: boolean; fallbackReason?: "cap" | "error" | "invalid" };
type Notice = { tone: "success" | "error"; text: string };
export type ShipmentSummary = { carrier: string; trackingNumber: string; pushed: boolean; delivered: boolean; simulated: boolean; shipTo: string | null };

const btn =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60";

/**
 * Seller Protection for one order: badge, each gap with its basis and plain-language line, and the fixes
 * (push tracking to PayPal, add tracking, demo-carrier delivery). Lines come from one cached AI call.
 */
export default function ProtectionPanel({
  orderId,
  result,
  shipment,
  standardLines,
  paypalAddress,
}: {
  orderId: string;
  result: ProtectionResult | null;
  shipment: ShipmentSummary | null;
  standardLines: Partial<Record<GapCode, string>>;
  paypalAddress: string | null;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [expl, setExpl] = useState<Explanation | null>(null);
  const [explState, setExplState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<"push" | "deliver" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const key = (result?.gaps ?? []).map((g) => g.code).sort().join(",");

  useEffect(() => {
    if (!key) return;
    let live = true;
    setExplState("loading");
    fetch(`/api/orders/${encodeURIComponent(orderId)}/protection`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: { explanation: Explanation | null }) => {
        if (!live) return;
        setExpl(b.explanation);
        setExplState("ready");
      })
      .catch(() => live && setExplState("error"));
    return () => {
      live = false;
    };
  }, [orderId, key]);

  const done = useCallback(
    (n: Notice) => {
      setNotice(n);
      startTransition(() => router.refresh());
    },
    [router],
  );

  async function post(kind: "push" | "deliver") {
    setBusy(kind);
    setNotice(null);
    try {
      const res =
        kind === "push"
          ? await fetch(`/api/orders/${encodeURIComponent(orderId)}/tracking`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ push: true }),
            })
          : await fetch("/api/demo/deliver", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderId }),
            });
      const body = (await res.json().catch(() => ({}))) as { error?: string; simulated?: boolean };
      if (!res.ok) return done({ tone: "error", text: body.error ?? "That did not work. Nothing was changed." });
      done({
        tone: "success",
        text:
          kind === "deliver"
            ? "Marked delivered by the demo carrier (Simulated)."
            : body.simulated
              ? "Tracking pushed (Simulated: this local dev order was not sent to PayPal)."
              : "Tracking is now on PayPal.",
      });
    } catch {
      setNotice({ tone: "error", text: "Network error. Nothing was changed." });
    } finally {
      setBusy(null);
    }
  }

  const badge = protectionBadge(result?.status);
  const lineFor = (code: GapCode) => {
    const ai = expl?.lines.find((l) => l.code === code)?.text;
    if (ai) return ai;
    return explState === "loading" ? null : (standardLines[code] ?? null);
  };

  return (
    <Panel
      id="protection"
      title="Seller Protection"
      subtitle="Checked against PayPal's US Seller Protection policy"
      actions={<Badge label={badge.label} tone={badge.tone} />}
      className="scroll-mt-24"
    >
      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "error" ? "border-orange-200 bg-orange-50 text-orange-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          {notice.text}
          {refreshing ? <span className="ml-2 text-xs opacity-70">Updating...</span> : null}
        </div>
      ) : null}

      {!result ? (
        <p className="text-sm text-muted">This order has not been checked yet.</p>
      ) : result.gaps.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <Icon name="shieldCheck" className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            <span className="font-semibold">Protected.</span> Shipped to the PayPal address, tracking is on PayPal and delivery is confirmed.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[#f1ebdf]">
          {result.gaps.map((g) => (
            <GapRow key={g.code} gap={g} line={lineFor(g.code)} lineFromAi={!!expl && !expl.usedFallback} loadingLine={explState === "loading"}>
              {g.code === "tracking_not_on_paypal" ? (
                <button type="button" onClick={() => post("push")} disabled={!!busy} className={`${btn} bg-green text-white hover:bg-[#243a2b]`}>
                  {busy === "push" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : <Icon name="upload" className="h-4 w-4" />}
                  Push tracking to PayPal
                </button>
              ) : g.code === "no_tracking" ? (
                <TrackingForm orderId={orderId} onDone={done} />
              ) : g.code === "no_delivery_confirmation" && shipment ? (
                <button
                  type="button"
                  onClick={() => post("deliver")}
                  disabled={!!busy}
                  className={`${btn} border border-dashed border-violet-400/70 bg-violet-50 text-violet-900 hover:bg-violet-100`}
                >
                  {busy === "deliver" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-300 border-t-violet-800" aria-hidden /> : <Icon name="truck" className="h-4 w-4" />}
                  Mark delivered (Simulated)
                </button>
              ) : g.code === "address_mismatch" && paypalAddress ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-[#f7f3ea] px-3 py-2 text-xs text-foreground/80">
                  <dt>PayPal address</dt>
                  <dd className="font-medium">{paypalAddress}</dd>
                  {shipment?.shipTo ? (
                    <>
                      <dt>Shipped to</dt>
                      <dd className="font-medium text-orange-800">{shipment.shipTo}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </GapRow>
          ))}
        </ul>
      )}

      {result && result.gaps.length > 0 ? (
        <p className="mt-4 flex items-center gap-1.5 border-t border-[#f1ebdf] pt-3 text-xs text-muted">
          <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
          {explState === "error"
            ? "Could not load the AI explanation - showing standard text."
            : expl?.usedFallback && expl.fallbackReason === "cap"
              ? "AI limit reached - showing standard text."
              : expl?.usedFallback
                ? "AI unavailable - showing standard text."
                : "Explanations are written by AI from this order's facts; the rules themselves are fixed."}
        </p>
      ) : null}
    </Panel>
  );
}
