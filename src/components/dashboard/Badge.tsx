import type { Tone } from "@/lib/dashboard/view";
import { TONE } from "./tone";

/** A status pill: always a dot plus a text label, so the colour is never the only signal. */
export default function Badge({
  label,
  tone,
  size = "md",
  title,
}: {
  label: string;
  tone: Tone;
  size?: "sm" | "md";
  title?: string;
}) {
  const t = TONE[tone];
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset ${pad} ${t.pill}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      {label}
    </span>
  );
}
