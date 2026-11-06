import type { Action, Recommendation } from "@/lib/defense/recommend";
import { ACTION_LABEL, evFormulaText, formatEv, percent } from "@/lib/dashboard/view";
import InfoTip from "../InfoTip";
import Panel from "../Panel";

const ORDER: Action[] = ["fight", "offer", "refund"];
const SHORT: Record<Action, string> = { fight: "Fight", offer: "Offer 50%", refund: "Refund" };

/** What Seller Shield recommends and the expected money kept under each option (estimates). */
export default function RecommendationCard({
  rec,
  amountCents,
  feeCents,
}: {
  rec: Recommendation;
  amountCents: number;
  feeCents: number;
}) {
  return (
    <Panel
      title="Recommendation"
      subtitle="Expected money kept from the sale - estimates"
      actions={
        <InfoTip label="How these estimates are calculated">
          {evFormulaText({ winProbability: rec.winProbability, amountCents, feeCents })}
        </InfoTip>
      }
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted">Recommended</p>
      <p className="mt-0.5 font-display text-xl text-green">{ACTION_LABEL[rec.action]}</p>
      <p className="mt-1 text-sm text-foreground/80">{rec.reason}</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {ORDER.map((a) => {
          const best = a === rec.action;
          return (
            <div
              key={a}
              className={`min-w-0 rounded-lg border px-2.5 py-2 ${best ? "border-green bg-[#eef3ee] ring-1 ring-green/30" : "border-[#ece5d6] bg-[#fdfbf6]"}`}
            >
              <p className={`truncate text-[11px] font-semibold uppercase tracking-wider ${best ? "text-green" : "text-muted"}`}>{SHORT[a]}</p>
              <p className="mt-0.5 truncate text-base font-semibold tabular-nums">{formatEv(rec.expectedValueCents[a])}</p>
              {best ? <p className="text-[11px] font-medium text-green">Best</p> : <p className="text-[11px] text-transparent">-</p>}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">Estimated win chance</span>
        <span className="font-semibold tabular-nums">{percent(rec.winProbability)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#efe8da]">
        <div className="h-full rounded-full bg-green" style={{ width: percent(rec.winProbability) }} />
      </div>
    </Panel>
  );
}
