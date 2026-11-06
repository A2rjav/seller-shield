import { mandateBadge, type MandateState } from "@/lib/dashboard/view";
import Icon from "./Icon";
import { TONE } from "./tone";

/** "Agent" source badge with the purchase-mandate state next to it. */
export default function AgentBadge({ state, compact = false }: { state: MandateState; compact?: boolean }) {
  const m = mandateBadge(state);
  const t = TONE[m.tone];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex items-center gap-1 rounded-full bg-green px-2 py-0.5 text-[11px] font-semibold text-white">
        <Icon name="bot" className="h-3.5 w-3.5" />
        Agent
      </span>
      <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${t.text}`} title={m.label}>
        <Icon name={state === "verified" ? "check" : state === "failed" ? "x" : "clock"} className="h-3.5 w-3.5" />
        {compact ? m.label.replace("Mandate ", "") : m.label}
      </span>
    </span>
  );
}
