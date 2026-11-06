import Link from "next/link";
import type { ReactNode } from "react";
import Badge from "@/components/dashboard/Badge";
import Panel from "@/components/dashboard/Panel";
import SimulatedTag from "@/components/dashboard/SimulatedTag";
import { aiBudget } from "@/lib/ai/budget";
import { listDisputeRows, listOrderRows } from "@/lib/dashboard/queries";
import { isOpenDispute } from "@/lib/dashboard/view";
import { db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";
import { resetCooldownSec } from "@/lib/demo/reset";
import { formatMoney } from "@/lib/format";
import { eq, ne } from "drizzle-orm";
import { DeliverButton, PollButton, ResetButton, ResolveButtons, SimulateDispute } from "./DemoActions";

export const dynamic = "force-dynamic";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green text-xs font-semibold text-white">{n}</span>
          {title}
        </span>
      }
    >
      <div className="space-y-3 text-sm text-foreground">{children}</div>
    </Panel>
  );
}

const A = "font-medium text-green underline underline-offset-2 hover:no-underline";

export default async function DemoPage() {
  const email = process.env.SANDBOX_BUYER_EMAIL?.trim();
  const password = process.env.SANDBOX_BUYER_PASSWORD?.trim();

  const [orderRows, disputeRows, undelivered, budget, cooldownSec] = await Promise.all([
    listOrderRows(db).catch(() => []),
    listDisputeRows(db).catch(() => []),
    db
      .select({ orderId: shipments.orderId, status: shipments.status, amountCents: orders.amountCents, currency: orders.currency, buyer: orders.shipName })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .where(ne(shipments.status, "delivered"))
      .catch(() => []),
    aiBudget(db).catch(() => null),
    resetCooldownSec(db).catch(() => 0),
  ]);

  const recent = orderRows.slice(0, 15);
  const atRisk = orderRows.find((o) => o.status === "at_risk");
  const openDisputes = disputeRows.filter((d) => isOpenDispute(d.status));
  const orderLabel = (id: string, buyer: string, cents: number, cur: string) => `${buyer} - ${formatMoney(cents, cur)} - ${id.slice(0, 8)}`;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-green sm:text-3xl">Demo guide</h1>
        <p className="mt-1 text-sm text-muted">
          Seller Shield protects Maya, who runs a small jewellery shop, from losing PayPal disputes. Follow the six steps. Everything runs in the PayPal sandbox
          with fake money; anything the sandbox cannot do is tagged <SimulatedTag />.
        </p>
        <p className="mt-2 text-sm text-muted">
          {budget ? (budget.configured ? <>AI calls left today: <strong className="text-foreground">{budget.left} of {budget.limit}</strong>. Past the cap the app uses standard text.</> : "AI is off on this deployment, so standard text is used.") : "AI usage is unavailable right now."}
        </p>
      </div>

      <Step n={1} title="Buy as a human">
        <p>
          Open the <Link href="/" className={A}>storefront</Link>, add a product and pay with PayPal. When PayPal asks you to log in, use the shared sandbox buyer below.
        </p>
        <div className="rounded-lg border border-dashed border-[#d9cfba] bg-[#faf6ec] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Sandbox test buyer (fake money)</p>
          {email && password ? (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Email</dt><dd className="break-all font-mono">{email}</dd>
              <dt className="text-muted">Password</dt><dd className="break-all font-mono">{password}</dd>
            </dl>
          ) : (
            <p className="mt-1.5 text-sm">Ask the team for the sandbox buyer login.</p>
          )}
        </div>
      </Step>

      <Step n={2} title="Let an AI agent buy">
        <p>
          Fund the agent&apos;s spending mandate in the <Link href="/wallet" className={A}>wallet</Link>, then ask the shopping agent to buy for you in
          <Link href="/agent" className={`${A} ml-1`}>the agent chat</Link>. The signed mandate becomes evidence that you authorised the purchase.
        </p>
      </Step>

      <Step n={3} title="See Prevent">
        <p>
          The <Link href="/dashboard" className={A}>orders dashboard</Link> shows each order&apos;s Seller Protection status and one-click fixes (push tracking, ship to the PayPal address).
          {atRisk ? <> Start with <Link href={`/dashboard/orders/${encodeURIComponent(atRisk.id)}`} className={A}>{atRisk.buyer}&apos;s order</Link>, which is at risk.</> : null}
        </p>
        {undelivered.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Shipped, not yet delivered</p>
            {undelivered.map((u) => (
              <div key={u.orderId} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-[#efe8da] px-3 py-2">
                <span className="min-w-0 text-sm">{u.buyer ?? "Buyer"} <span className="text-muted">- {formatMoney(u.amountCents, u.currency)}</span></span>
                <DeliverButton orderId={u.orderId} />
              </div>
            ))}
          </div>
        ) : null}
      </Step>

      <Step n={4} title="Open a dispute">
        <p>Fastest: open a dispute on any order. It is made by the demo, not PayPal, and is tagged <SimulatedTag />.</p>
        <SimulateDispute orders={recent.map((o) => ({ id: o.id, label: orderLabel(o.id, o.buyer, o.amountCents, o.currency) }))} />
        <details className="rounded-lg border border-[#efe8da] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-green">Open a real PayPal sandbox dispute</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>Go to <a className={A} href="https://www.sandbox.paypal.com" target="_blank" rel="noreferrer">sandbox.paypal.com</a> and log in as the sandbox test buyer shown in step 1.</li>
            <li>Open Activity and click the transaction you made.</li>
            <li>Choose Report a problem and pick a reason, for example Item not received.</li>
            <li>Come back here and check PayPal for the new dispute (it can take a minute to appear).</li>
          </ol>
          <div className="mt-3"><PollButton /></div>
        </details>
      </Step>

      <Step n={5} title="Defend it">
        <p>
          Open the <Link href="/dashboard/disputes" className={A}>disputes inbox</Link>. Seller Shield gathers the evidence, recommends fight or accept, and drafts a case
          where every sentence cites its evidence. Nothing is sent to PayPal until Maya clicks submit.
        </p>
      </Step>

      <Step n={6} title="Resolve">
        {openDisputes.length === 0 ? (
          <p className="text-muted">No open disputes. Open one in step 4.</p>
        ) : (
          <ul className="space-y-2">
            {openDisputes.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[#efe8da] px-3 py-2">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {d.reasonLabel} - {formatMoney(d.amountCents, d.currency)}
                    {d.simulated ? <SimulatedTag title="A demo dispute: resolving it does not call PayPal" /> : <Badge label="PayPal sandbox" tone="blue" size="sm" />}
                  </p>
                  <p className="break-all text-xs text-muted">{d.id}{d.simulated ? "" : ". The sandbox only settles a dispute once it is under review (after you submit evidence)."}</p>
                </div>
                <ResolveButtons disputeId={d.id} simulated={d.simulated} />
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Panel title="Reset the demo" subtitle="Several judges share this demo. Reset removes visitor orders and disputes and restores the sample data. PayPal is never changed.">
        <ResetButton cooldownSec={cooldownSec} />
      </Panel>
    </div>
  );
}
