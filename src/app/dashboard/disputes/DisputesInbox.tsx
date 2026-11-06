"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/dashboard/Icon";
import Panel from "@/components/dashboard/Panel";
import type { DisputeRow } from "@/lib/dashboard/queries";
import DisputesGrid from "./DisputesGrid";

type PollState = { checked?: number; created?: number; changed?: number; lastPolledAt: string | null; cached?: boolean; error?: string };

function describe(p: PollState): string {
  if (!p.lastPolledAt) return "Not checked yet.";
  const secs = Math.max(0, Math.round((Date.now() - new Date(p.lastPolledAt).getTime()) / 1000));
  const ago = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
  if (p.cached) return `Checked ${ago}. PayPal is checked at most every 30 seconds, so this is the latest result.`;
  return `Checked PayPal just now: ${p.checked ?? 0} disputes, ${p.created ?? 0} new, ${p.changed ?? 0} updated.`;
}

/** Disputes grid plus "Refresh from PayPal" (the throttled poll route). */
export default function DisputesInbox({ rows, initialPoll }: { rows: DisputeRow[]; initialPoll: PollState | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [poll, setPoll] = useState<PollState | null>(initialPoll);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cron/poll-disputes", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as PollState;
      if (!res.ok) {
        setError("Could not reach PayPal just now. Showing the disputes already on file; webhooks still deliver new ones.");
      } else {
        setPoll(body);
        startTransition(() => router.refresh());
      }
    } catch {
      setError("Network error. Showing the disputes already on file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Dispute inbox"
      subtitle={poll ? describe(poll) : "New disputes arrive by PayPal webhook."}
      bodyClassName="p-0"
      actions={
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#e0d7c3] bg-white px-3 py-1.5 text-sm font-semibold text-green hover:bg-[#f4f7f3] disabled:opacity-60"
        >
          <Icon name="refresh" className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          Refresh from PayPal
        </button>
      }
    >
      {error ? (
        <p role="alert" className="border-b border-orange-200 bg-orange-50 px-4 py-2 text-sm text-orange-900 sm:px-5">
          {error}
        </p>
      ) : null}
      <DisputesGrid rows={rows} loading={busy || refreshing} />
    </Panel>
  );
}
