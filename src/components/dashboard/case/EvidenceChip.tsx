"use client";

import { useId, useRef, useState } from "react";
import type { EvidenceItem } from "@/lib/evidence/folder";
import { evidenceKindLabel, evidenceSourceLabel } from "@/lib/dashboard/view";
import SimulatedTag from "../SimulatedTag";

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A citation chip. Hover, focus or tap shows the cited evidence item; leaving it or tapping elsewhere hides it. */
export default function EvidenceChip({ id, item, n }: { id: string; item: EvidenceItem | undefined; n: number }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAlignRight(r.left > window.innerWidth / 2);
    setOpen(true);
  };

  if (!item) {
    return (
      <span className="ml-1 inline-flex items-center rounded bg-red-100 px-1.5 text-[11px] font-semibold text-red-800" title={`Cited item ${id} is not in the evidence folder`}>
        missing
      </span>
    );
  }
  return (
    <span ref={ref} className="relative ml-1 inline-flex align-baseline" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        // Hover and focus already open it, so a click (or a tap, which fires both first) must not toggle it shut.
        onClick={show}
        onFocus={show}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? tipId : undefined}
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-semibold leading-4 ring-1 ring-inset transition-colors ${
          item.simulated ? "bg-violet-50 text-violet-800 ring-violet-300 hover:bg-violet-100" : "bg-[#eef3ee] text-green ring-green/20 hover:bg-[#e2ebe3]"
        }`}
      >
        <span className="tabular-nums opacity-70">{n}</span>
        {evidenceKindLabel(item.kind)}
      </button>
      {open ? (
        <span
          id={tipId}
          role="tooltip"
          className={`absolute top-6 z-40 block w-72 max-w-[calc(100vw-3rem)] rounded-lg border border-[#e7dfcf] bg-white p-3 text-left text-xs font-normal leading-relaxed text-foreground shadow-xl ${
            alignRight ? "right-0" : "left-0"
          }`}
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{item.title}</span>
            {item.simulated ? <SimulatedTag /> : null}
          </span>
          <span className="mt-0.5 block text-muted">
            {item.at ? when.format(new Date(item.at)) : "Date not recorded"} · Source: {evidenceSourceLabel(item.source)}
          </span>
          <span className="mt-1.5 block break-words">{item.summary}</span>
          <span className="mt-1.5 block truncate font-mono text-[10px] text-muted">{item.id}</span>
        </span>
      ) : null}
    </span>
  );
}
