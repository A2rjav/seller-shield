"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SimulatedTag from "@/components/dashboard/SimulatedTag";
import { disputeCaseHref } from "@/lib/dashboard/view";

type Status = { kind: "idle" | "busy" | "ok" | "error"; msg?: string; href?: string };

const BTN = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BTN} bg-green text-white hover:bg-[#243a2b]`;
const OUTLINE = `${BTN} border border-[#d9cfba] bg-white text-foreground hover:bg-[#f7f2e7]`;
const FIELD = "min-w-0 rounded-lg border border-[#d9cfba] bg-white px-2.5 py-1.5 text-sm text-foreground";

/** Runs a POST, shows inline progress / success / error (no alert or confirm), and refreshes the server data. */
function useAction() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  async function run(url: string, body: unknown, okMsg: (data: Record<string, unknown>) => string, okHref?: (data: Record<string, unknown>) => string | undefined) {
    setStatus({ kind: "busy" });
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setStatus({ kind: "error", msg: typeof data.error === "string" ? data.error : "Something went wrong. Please try again." });
      } else {
        setStatus({ kind: "ok", msg: okMsg(data), href: okHref?.(data) });
        router.refresh();
      }
      return res.ok;
    } catch {
      setStatus({ kind: "error", msg: "Could not reach the server. Please try again." });
      return false;
    }
  }
  return { status, run };
}

function Note({ status }: { status: Status }) {
  if (status.kind === "idle" || status.kind === "busy") return <span className="sr-only" aria-live="polite">{status.kind === "busy" ? "Working" : ""}</span>;
  return (
    <p role={status.kind === "error" ? "alert" : "status"} className={`text-xs ${status.kind === "error" ? "text-[#9b2c1d]" : "text-[#2f6b3f]"}`}>
      {status.msg}
      {status.kind === "ok" && status.href ? (
        <>
          {" "}
          <Link href={status.href} className="font-medium underline underline-offset-2 hover:no-underline">Open the case</Link>
        </>
      ) : null}
    </p>
  );
}

export function DeliverButton({ orderId }: { orderId: string }) {
  const { status, run } = useAction();
  return (
    <div className="flex flex-col items-start gap-1">
      <button className={OUTLINE} disabled={status.kind === "busy"} onClick={() => run("/api/demo/deliver", { orderId }, () => "Marked delivered (simulated).")}>
        {status.kind === "busy" ? "Working..." : "Mark delivered"} <SimulatedTag />
      </button>
      <Note status={status} />
    </div>
  );
}

const REASONS = [
  { value: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", label: "Item not received" },
  { value: "UNAUTHORISED", label: "Unauthorized payment (\"my AI bought it\")" },
  { value: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", label: "Not as described" },
];

export function SimulateDispute({ orders }: { orders: { id: string; label: string }[] }) {
  const { status, run } = useAction();
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const [reason, setReason] = useState(REASONS[0].value);
  if (orders.length === 0) return <p className="text-sm text-muted">No orders yet. Buy something first (step 1 or 2), or reset the demo.</p>;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const idOf = (d: Record<string, unknown>) => String((d.dispute as { id?: string })?.id ?? "");
        void run("/api/demo/dispute", { orderId, reason }, (d) => `Simulated dispute ${idOf(d)} opened.`, (d) => disputeCaseHref(idOf(d)));
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 basis-56">
          <span className="sr-only">Order</span>
          <select className={`${FIELD} w-full`} value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            {orders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 basis-56">
          <span className="sr-only">Reason</span>
          <select className={`${FIELD} w-full`} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <button type="submit" className={PRIMARY} disabled={status.kind === "busy"}>
          {status.kind === "busy" ? "Opening..." : "Simulate dispute"} <SimulatedTag />
        </button>
      </div>
      <Note status={status} />
    </form>
  );
}

/** Simulated disputes only: closes the demo dispute locally (nothing is sent to PayPal). */
export function ResolveButtons({ disputeId }: { disputeId: string }) {
  const { status, run } = useAction();
  const go = (outcome: "SELLER_FAVOR" | "BUYER_FAVOR") => run("/api/demo/adjudicate", { disputeId, outcome }, () => "Resolved (simulated).");
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-2">
        <button className={PRIMARY} disabled={status.kind === "busy"} onClick={() => go("SELLER_FAVOR")}>Resolve in seller&apos;s favour</button>
        <button className={OUTLINE} disabled={status.kind === "busy"} onClick={() => go("BUYER_FAVOR")}>Resolve in buyer&apos;s favour</button>
      </div>
      <p className="text-[11px] text-muted">Simulated: closes the demo dispute locally.</p>
      <Note status={status} />
    </div>
  );
}

const stateText = (d: Record<string, unknown>) => {
  const x = (d.dispute ?? {}) as { status?: string; stage?: string };
  return `${String(x.status ?? "").toLowerCase().replace(/_/g, " ")}${x.stage ? `, ${String(x.stage).toLowerCase()} stage` : ""}`;
};

/** Real sandbox disputes: re-reads the dispute from PayPal so the page shows its current PayPal status. */
export function RefreshDisputeButton({ disputeId }: { disputeId: string }) {
  const { status, run } = useAction();
  return (
    <div className="flex flex-col items-start gap-1">
      <button className={OUTLINE} disabled={status.kind === "busy"} onClick={() => run("/api/demo/fetch-dispute", { disputeId }, (d) => `PayPal says: ${stateText(d)}.`)}>
        {status.kind === "busy" ? "Checking..." : "Refresh status from PayPal"}
      </button>
      <Note status={status} />
    </div>
  );
}

/** Fetches one real sandbox dispute by the id PayPal showed the buyer, without waiting for PayPal's dispute list. */
export function FetchDisputeForm() {
  const { status, run } = useAction();
  const [id, setId] = useState("");
  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        void run("/api/demo/fetch-dispute", { disputeId: id }, (d) => {
          const x = (d.dispute ?? {}) as { id?: string; orderId?: string | null };
          return `Fetched ${String(x.id ?? "")} (${stateText(d)})${x.orderId ? "" : ". It is not linked to an order in this demo"}.`;
        }, (d) => disputeCaseHref(String((d.dispute as { id?: string } | undefined)?.id ?? "")));
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 basis-56">
          <span className="sr-only">PayPal dispute ID</span>
          <input
            className={`${FIELD} w-full font-mono`}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="PP-R-ABC-12345678"
            autoComplete="off"
            spellCheck={false}
            maxLength={48}
          />
        </label>
        <button type="submit" className={OUTLINE} disabled={status.kind === "busy" || id.trim() === ""}>
          {status.kind === "busy" ? "Fetching..." : "Fetch dispute"}
        </button>
      </div>
      <Note status={status} />
    </form>
  );
}

export function PollButton() {
  const { status, run } = useAction();
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        className={OUTLINE}
        disabled={status.kind === "busy"}
        onClick={() =>
          run("/api/cron/poll-disputes", {}, (d) =>
            d.cached ? "Checked a few seconds ago; nothing new yet. Try again in 30 seconds." : `Checked PayPal: ${Number(d.created ?? 0)} new, ${Number(d.changed ?? 0)} updated.`,
          )
        }
      >
        {status.kind === "busy" ? "Checking..." : "Check PayPal for new disputes"}
      </button>
      <Note status={status} />
    </div>
  );
}

export function ResetButton({ cooldownSec }: { cooldownSec: number }) {
  const { status, run } = useAction();
  const [left, setLeft] = useState(cooldownSec);
  useEffect(() => setLeft(cooldownSec), [cooldownSec]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [left]);
  async function reset() {
    const ok = await run("/api/demo/reset", {}, (d) => `Demo reset. ${Number((d.deleted as { orders?: number })?.orders ?? 0)} visitor order(s) removed.`);
    if (ok) setLeft(120);
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button className={PRIMARY} disabled={status.kind === "busy" || left > 0} onClick={reset}>
        {status.kind === "busy" ? "Resetting..." : left > 0 ? `Reset demo (available in ${left}s)` : "Reset demo"}
      </button>
      <Note status={status} />
    </div>
  );
}
