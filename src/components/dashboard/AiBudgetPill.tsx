import type { AiBudget } from "@/lib/ai/budget";
import Icon from "./Icon";

/** Today's Gemini budget. Past the cap the app uses standard text and templates. */
export default function AiBudgetPill({ budget }: { budget: AiBudget | null }) {
  const text = !budget ? "AI usage unavailable" : !budget.configured ? "AI off - standard text" : `${budget.left} AI calls left today`;
  const title = budget
    ? `Gemini calls today (UTC): ${budget.used} of ${budget.limit}. Past the cap Seller Shield uses standard text and templates.`
    : "Could not read today's AI usage";
  return (
    <span title={title} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white/90 ring-1 ring-inset ring-white/15">
      <Icon name="sparkles" className="h-3.5 w-3.5 text-[#f2c9a8]" />
      {text}
    </span>
  );
}
