import { mandateFailureLabel, mandateStateOf } from "@/lib/dashboard/view";
import { formatMoney } from "@/lib/format";
import AgentBadge from "../AgentBadge";
import Panel from "../Panel";

type MandateRow = {
  id: string;
  payload: unknown;
  hash: string;
  verified: boolean;
  failures: unknown;
  payerEmailMatch: boolean | null;
};

type Payload = {
  mandateId?: string;
  shopperEmail?: string;
  agentId?: string;
  maxAmountCents?: number;
  currency?: string;
  items?: { sku?: string; qty?: number }[];
  createdAt?: string;
  expiresAt?: string;
};

const day = (v?: string) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "not recorded";
};

/** The AI agent's purchase mandate: what the shopper signed, and whether it verified. */
export default function MandatePanel({ mandate }: { mandate: MandateRow | null }) {
  if (!mandate) {
    return (
      <Panel title="Purchase mandate" actions={<AgentBadge state="not_checked" />}>
        <p className="text-sm text-muted">An AI agent placed this order, but no signed mandate is on file, so there is no proof the buyer authorised it.</p>
      </Panel>
    );
  }
  const p = (mandate.payload ?? {}) as Payload;
  const failures = Array.isArray(mandate.failures) ? (mandate.failures as string[]) : [];
  const rows: [string, string][] = [
    ["Mandate", p.mandateId ?? mandate.id],
    ["Signed by shopper", p.shopperEmail ?? "unknown"],
    ["Agent", p.agentId ?? "unknown"],
    ["Spending limit", typeof p.maxAmountCents === "number" ? formatMoney(p.maxAmountCents, p.currency ?? "USD") : "unknown"],
    ["Items allowed", (p.items ?? []).map((i) => `${i.qty ?? 1} x ${i.sku ?? "?"}`).join(", ") || "none"],
    ["Valid", `${day(p.createdAt)} to ${day(p.expiresAt)}`],
    ["PayPal payer email", mandate.payerEmailMatch === true ? "Matches the shopper" : mandate.payerEmailMatch === false ? "Does not match" : "Not checked"],
  ];
  return (
    <Panel title="Purchase mandate" subtitle="Signed proof that the buyer authorised their AI agent" actions={<AgentBadge state={mandateStateOf(mandate)} />}>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-foreground">{v}</dd>
          </div>
        ))}
        <dt className="text-muted">Hash</dt>
        <dd className="min-w-0 truncate font-mono text-xs text-foreground/80" title={mandate.hash}>
          {mandate.hash}
        </dd>
      </dl>
      {failures.length ? (
        <ul className="mt-4 space-y-1 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900">
          {failures.map((f) => (
            <li key={f}>{mandateFailureLabel(f)}</li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
