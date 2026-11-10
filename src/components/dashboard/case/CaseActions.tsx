"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/format";
import ConfirmModal from "../ConfirmModal";
import Icon from "../Icon";
import Panel from "../Panel";

type Kind = "submit" | "offer" | "accept";
export type ActionNotice = { tone: "success" | "error"; text: string };

const DEFAULT_OFFER_NOTE = "I would like to resolve this with a partial refund.";
const DEFAULT_ACCEPT_NOTE = "I accept this claim and will refund the buyer.";

/**
 * Submit evidence / Make offer / Accept claim. Each opens a confirm dialog that states exactly what goes to
 * PayPal; only the confirm click sends the request, with `sellerConfirmed: true`.
 */
export default function CaseActions({
  disputeId,
  simulated,
  resolved,
  amountCents,
  currency,
  offerCents,
  offerBlockedReason = null,
  acceptBlockedReason = null,
  submitBlockedReason,
  priorAction,
  notesPreview,
  evidenceType,
  evidenceCount,
  asSupportingInfo = false,
  onDone,
}: {
  disputeId: string;
  simulated: boolean;
  resolved: boolean;
  amountCents: number;
  currency: string;
  offerCents: number;
  /** Set when the dispute stage does not allow offers (chargeback); the button is disabled and this line shown. */
  offerBlockedReason?: string | null;
  /** Set when PayPal offers no accept-claim action on a real dispute. */
  acceptBlockedReason?: string | null;
  submitBlockedReason: string | null;
  priorAction: string | null;
  notesPreview: string;
  evidenceType: string;
  evidenceCount: number;
  /** PayPal is reviewing the claim and takes supporting information instead of a formal evidence response. */
  asSupportingInfo?: boolean;
  onDone: (n: ActionNotice) => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(null);
    setError(null);
  };

  async function confirm() {
    if (!open) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { sellerConfirmed: true };
    if (open === "offer") body.amountCents = offerCents;
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(disputeId)}/${open}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = (await res.json().catch(() => ({}))) as { submitted?: boolean; simulated?: boolean; error?: string };
      if (!res.ok || !r.submitted) {
        setError(r.error ?? "PayPal did not accept this. Nothing was changed.");
        return;
      }
      const what = open === "submit" ? "Evidence submitted" : open === "offer" ? `Offer of ${formatMoney(offerCents, currency)} sent` : "Claim accepted";
      const text = r.simulated ? `${what} (Simulated dispute: recorded here, nothing was sent to PayPal).` : `${what} to PayPal.`;
      setOpen(null);
      setLast(text);
      onDone({ tone: "success", text });
    } catch {
      setError("Network error. Nothing was sent.");
    } finally {
      setBusy(false);
    }
  }

  const btn = "inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
  const offerDone = priorAction === "offer";
  const acceptDone = priorAction === "accept";
  const intro = simulated
    ? "Simulated dispute: nothing is sent to PayPal. Seller Shield records exactly what would be sent:"
    : `This sends the following to PayPal (sandbox dispute ${disputeId}):`;

  return (
    <Panel title="Respond" subtitle="Nothing is sent to PayPal until you confirm">
      <div className="space-y-2">
        <button type="button" onClick={() => setOpen("submit")} disabled={resolved || !!submitBlockedReason} className={`${btn} bg-green text-white hover:bg-[#243a2b]`}>
          <Icon name="upload" className="h-4 w-4" /> Submit evidence
        </button>
        {submitBlockedReason ? <p className="text-xs text-muted">{submitBlockedReason}</p> : null}
        <button
          type="button"
          onClick={() => setOpen("offer")}
          disabled={resolved || offerDone || acceptDone || !!offerBlockedReason}
          className={`${btn} border border-[#e0d7c3] bg-white text-foreground hover:bg-[#f7f3ea]`}
        >
          <Icon name="dollar" className="h-4 w-4" /> Make offer ({formatMoney(offerCents, currency)})
        </button>
        {offerBlockedReason && !resolved ? <p className="text-xs text-muted">{offerBlockedReason}</p> : null}
        <button
          type="button"
          onClick={() => setOpen("accept")}
          disabled={resolved || acceptDone || !!acceptBlockedReason}
          className={`${btn} border border-orange-200 bg-white text-orange-800 hover:bg-orange-50`}
        >
          Accept claim and refund
        </button>
        {acceptBlockedReason && !resolved ? <p className="text-xs text-muted">{acceptBlockedReason}</p> : null}
        {resolved ? <p className="text-xs text-muted">This dispute is resolved; no further action is possible.</p> : null}
        {last ? (
          <p role="status" className="flex items-start gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <Icon name="check" className="mt-px h-3.5 w-3.5 shrink-0" />
            {last}
          </p>
        ) : null}
      </div>

      <ConfirmModal
        open={open === "submit"}
        title="Submit this evidence?"
        confirmLabel="Yes, submit evidence"
        busy={busy}
        error={error}
        onConfirm={confirm}
        onClose={close}
      >
        <p>{intro}</p>
        <ul className="list-disc space-y-1 pl-5">
          {asSupportingInfo ? (
            <li>Sent as supporting information: PayPal is reviewing this claim, so it takes documents rather than a formal evidence response</li>
          ) : (
            <li>Evidence type: <span className="font-mono text-xs">{evidenceType}</span></li>
          )}
          <li>The evidence PDF with {evidenceCount} cited records (as previewed on this page)</li>
          <li>Your notes:</li>
        </ul>
        <blockquote className="max-h-32 overflow-y-auto rounded-lg bg-[#f7f3ea] px-3 py-2 text-xs">{notesPreview || "Evidence attached."}</blockquote>
        <p className="text-xs text-muted">Evidence can be submitted once. The case cannot be rebuilt afterwards.</p>
      </ConfirmModal>

      <ConfirmModal open={open === "offer"} title="Offer a partial refund?" confirmLabel={`Yes, offer ${formatMoney(offerCents, currency)}`} busy={busy} error={error} onConfirm={confirm} onClose={close}>
        <p>{intro}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Partial refund of <span className="font-semibold">{formatMoney(offerCents, currency)}</span> (50% of {formatMoney(amountCents, currency)})</li>
          <li>Note to the buyer: &ldquo;{DEFAULT_OFFER_NOTE}&rdquo;</li>
        </ul>
        <p className="text-xs text-muted">If the buyer accepts, PayPal refunds this amount and closes the dispute.</p>
      </ConfirmModal>

      <ConfirmModal open={open === "accept"} title="Accept the claim?" confirmLabel="Yes, accept and refund" danger busy={busy} error={error} onConfirm={confirm} onClose={close}>
        <p>{intro}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>You accept the buyer&apos;s claim</li>
          <li>The buyer is refunded <span className="font-semibold">{formatMoney(amountCents, currency)}</span> and the dispute closes in their favour</li>
          <li>Note: &ldquo;{DEFAULT_ACCEPT_NOTE}&rdquo;</li>
        </ul>
        <p className="text-xs text-muted">This cannot be undone.</p>
      </ConfirmModal>
    </Panel>
  );
}
