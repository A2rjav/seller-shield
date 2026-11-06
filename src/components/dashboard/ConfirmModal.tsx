"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Icon from "./Icon";

/**
 * Confirmation step before anything is sent to PayPal. Native <dialog> (focus trap, Escape to close).
 * Nothing happens until the seller clicks the confirm button.
 */
export default function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
      aria-labelledby="confirm-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-[#e7dfcf] bg-white p-0 text-foreground shadow-2xl backdrop:bg-[#1d261d]/45 backdrop:backdrop-blur-[2px]"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${danger ? "bg-orange-100 text-orange-700" : "bg-[#eef3ee] text-green"}`}>
            <Icon name={danger ? "alert" : "upload"} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-base font-semibold">{title}</h2>
            <div className="mt-2 space-y-3 text-sm text-foreground/85">{children}</div>
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-4 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-[#e0d7c3] bg-white px-4 py-2 text-sm font-medium text-foreground hover:bg-[#f7f3ea] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
              danger ? "bg-orange-700 hover:bg-orange-800" : "bg-green hover:bg-[#243a2b]"
            }`}
          >
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : null}
            {busy ? "Sending..." : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
