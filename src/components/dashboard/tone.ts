import type { Tone } from "@/lib/dashboard/view";

/** Tailwind classes per tone. Every use pairs the colour with a text label. */
export const TONE: Record<Tone, { pill: string; dot: string; bar: string; text: string }> = {
  green: { pill: "bg-emerald-50 text-emerald-800 ring-emerald-700/20", dot: "bg-emerald-600", bar: "bg-emerald-600", text: "text-emerald-800" },
  amber: { pill: "bg-amber-50 text-amber-900 ring-amber-700/25", dot: "bg-amber-500", bar: "bg-amber-500", text: "text-amber-900" },
  red: { pill: "bg-orange-50 text-orange-900 ring-orange-700/25", dot: "bg-orange-600", bar: "bg-orange-600", text: "text-orange-800" },
  gray: { pill: "bg-stone-100 text-stone-700 ring-stone-500/20", dot: "bg-stone-400", bar: "bg-stone-400", text: "text-stone-600" },
  blue: { pill: "bg-sky-50 text-sky-900 ring-sky-700/20", dot: "bg-sky-600", bar: "bg-sky-600", text: "text-sky-800" },
};
