"use client";

import { useId, useState, type ReactNode } from "react";
import Icon from "./Icon";

/** Small "i" button that reveals an explanation on hover, focus or tap. */
export default function InfoTip({ label, children, align = "right" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-[#f3eee3] hover:text-green"
      >
        <Icon name="info" className="h-4 w-4" />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={`absolute top-6 z-40 w-72 max-w-[calc(100vw-3rem)] rounded-lg bg-[#1f2b21] px-3 py-2 text-xs leading-relaxed text-white shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
