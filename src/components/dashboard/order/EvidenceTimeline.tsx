import type { EvidenceItem, EvidenceKind } from "@/lib/evidence/folder";
import { evidenceSourceLabel } from "@/lib/dashboard/view";
import EmptyState from "../EmptyState";
import Icon, { type IconName } from "../Icon";
import SimulatedTag from "../SimulatedTag";

const KIND_ICON: Record<EvidenceKind, IconName> = {
  order: "package",
  capture: "dollar",
  ship_address: "package",
  tracking: "truck",
  delivery: "check",
  signature: "check",
  buyer_message: "inbox",
  policy_at_checkout: "file",
  mandate: "key",
  payer_approval: "shieldCheck",
  agent_identity: "bot",
  refund: "dollar",
  dispute: "alert",
};

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** Every item in the order's evidence folder, oldest first, with its source and a Simulated tag where it applies. */
export default function EvidenceTimeline({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return <EmptyState icon="file" title="No evidence yet">Evidence appears as the order is paid, shipped and delivered.</EmptyState>;
  }
  return (
    <ol className="relative">
      {items.map((item, i) => (
        <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
          {i < items.length - 1 ? <span className="absolute left-[15px] top-8 bottom-0 w-px bg-[#e7dfcf]" aria-hidden /> : null}
          <span
            className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-white ${
              item.simulated ? "bg-violet-50 text-violet-700" : "bg-[#eef3ee] text-green"
            }`}
          >
            <Icon name={KIND_ICON[item.kind] ?? "file"} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-semibold text-foreground">{item.title}</p>
              <span className="rounded bg-[#f3eee3] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-muted">
                {evidenceSourceLabel(item.source)}
              </span>
              {item.simulated ? <SimulatedTag /> : null}
            </div>
            <p className="mt-0.5 text-xs text-muted">{item.at ? `${when.format(new Date(item.at))} UTC` : "Date not recorded"}</p>
            <p className="mt-1 break-words text-sm text-foreground/80">{item.summary}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
