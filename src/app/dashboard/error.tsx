"use client";

import ErrorState from "@/components/dashboard/ErrorState";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <ErrorState
        title="This page could not load"
        action={
          <button type="button" onClick={reset} className="rounded-lg bg-green px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#243a2b]">
            Try again
          </button>
        }
      >
        Seller Shield could not reach its database just now. Nothing was changed and nothing was sent to PayPal.
      </ErrorState>
    </div>
  );
}
