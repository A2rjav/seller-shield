"use client";

import { useState } from "react";
import { CARRIERS, TRACKING_NUMBER_RE } from "@/lib/shipments/carriers";

/** Records a tracking number and sends it to PayPal in one step. */
export default function TrackingForm({
  orderId,
  onDone,
}: {
  orderId: string;
  onDone: (n: { tone: "success" | "error"; text: string }) => void;
}) {
  const [carrier, setCarrier] = useState<string>(CARRIERS[0]);
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const number = tracking.replace(/[\s-]+/g, "");
    if (!TRACKING_NUMBER_RE.test(number)) {
      setError("Enter the tracking number from your label: 8-40 letters or digits.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrier, trackingNumber: number }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; simulated?: boolean };
      if (!res.ok) {
        setError(body.error ?? "Could not add tracking.");
        if (res.status === 502 || res.status === 409) onDone({ tone: "error", text: body.error ?? "Tracking saved, but PayPal did not accept it." });
        return;
      }
      setTracking("");
      onDone({
        tone: "success",
        text: body.simulated
          ? "Tracking added (Simulated push: this local dev order was not sent to PayPal)."
          : "Tracking added and sent to PayPal.",
      });
    } catch {
      setError("Network error. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-[#e7dfcf] bg-[#fdfbf6] p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sm:w-28">
          <span className="sr-only">Carrier</span>
          <select
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            className="w-full rounded-lg border border-[#e0d7c3] bg-white px-2.5 py-1.5 text-sm outline-none focus:border-green/50 focus:ring-2 focus:ring-green/15"
          >
            {CARRIERS.map((c) => (
              <option key={c} value={c}>
                {c === "FEDEX" ? "FedEx" : c}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Tracking number</span>
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="Tracking number"
            inputMode="text"
            autoComplete="off"
            className="w-full rounded-lg border border-[#e0d7c3] bg-white px-3 py-1.5 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted/70 focus:border-green/50 focus:ring-2 focus:ring-green/15"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-green px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#243a2b] disabled:opacity-60"
        >
          {busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : null}
          Add &amp; push to PayPal
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-orange-800">
          {error}
        </p>
      ) : null}
    </form>
  );
}
