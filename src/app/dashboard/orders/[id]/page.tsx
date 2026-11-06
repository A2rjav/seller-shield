import Link from "next/link";
import { notFound } from "next/navigation";
import AgentBadge from "@/components/dashboard/AgentBadge";
import Badge from "@/components/dashboard/Badge";
import Icon from "@/components/dashboard/Icon";
import EvidenceTimeline from "@/components/dashboard/order/EvidenceTimeline";
import MandatePanel from "@/components/dashboard/order/MandatePanel";
import ProtectionPanel from "@/components/dashboard/order/ProtectionPanel";
import Panel from "@/components/dashboard/Panel";
import SimulatedTag from "@/components/dashboard/SimulatedTag";
import { db } from "@/lib/db/client";
import { getOrderDetail, sortGaps } from "@/lib/dashboard/queries";
import { disputeStatusChip, mandateStateOf, protectionBadge, reasonLabel } from "@/lib/dashboard/view";
import { buildEvidenceFolder } from "@/lib/evidence/folder";
import { formatMoney } from "@/lib/format";
import type { Address } from "@/lib/paypal/types";
import { FALLBACK_TEXT } from "@/lib/protection/explain";
import { isDevFixture, primaryShipment } from "@/lib/shipments/service";

export const dynamic = "force-dynamic";

const fmtDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const addressLine = (a: Address | null) => (a ? [a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`, a.countryCode].filter(Boolean).join(", ") : null);

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getOrderDetail(db, id);
  if (!detail) notFound();
  const { order, result, shipments, mandate, disputes } = detail;
  const evidence = await buildEvidenceFolder(db, { orderId: order.id });

  const ship = primaryShipment(shipments);
  const sortedResult = result ? { ...result, gaps: sortGaps(result.gaps) } : null;
  const badge = protectionBadge(result?.status);
  const items = Array.isArray(order.items) ? (order.items as { name?: string; sku?: string; qty?: number; priceCents?: number }[]) : [];
  const paypalAddress = addressLine((order.shipAddress ?? null) as Address | null);
  const standardLines = Object.fromEntries((result?.gaps ?? []).map((g) => [g.code, FALLBACK_TEXT[g.code]]));
  const fixture = isDevFixture(order.raw);

  return (
    <div className="space-y-6">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-green">
        <Icon name="arrowLeft" className="h-4 w-4" /> Orders
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-all font-mono text-xl font-semibold text-green sm:text-2xl">{order.id}</h1>
            {fixture ? <SimulatedTag title="Local dev fixture: this order never existed at PayPal" /> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {order.shipName ?? order.buyerEmail ?? "Unknown buyer"}
            {order.buyerEmail && order.shipName ? ` · ${order.buyerEmail}` : ""} · {fmtDate.format(order.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {order.source === "agent" ? <AgentBadge state={mandateStateOf(mandate)} /> : <Badge label="Storefront" tone="gray" />}
          <Badge label={badge.label} tone={badge.tone} />
          <span className="text-xl font-semibold tabular-nums">{formatMoney(order.amountCents, order.currency)}</span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <ProtectionPanel
            orderId={order.id}
            result={sortedResult}
            standardLines={standardLines}
            paypalAddress={paypalAddress}
            shipment={
              ship
                ? { carrier: ship.carrier, trackingNumber: ship.trackingNumber, pushed: ship.pushedToPaypal, delivered: ship.status === "delivered", simulated: ship.simulated, shipTo: addressLine((ship.shipToAddress ?? null) as Address | null) }
                : null
            }
          />
          <Panel title="Evidence timeline" subtitle={`${evidence.length} items in this order's evidence folder, oldest first`}>
            <EvidenceTimeline items={evidence} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Order">
            <ul className="space-y-2 text-sm">
              {items.map((i, n) => (
                <li key={n} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    {i.qty ?? 1} x {i.name ?? i.sku}
                  </span>
                  {typeof i.priceCents === "number" ? <span className="shrink-0 tabular-nums text-muted">{formatMoney(i.priceCents * (i.qty ?? 1))}</span> : null}
                </li>
              ))}
            </ul>
            <dl className="mt-4 space-y-3 border-t border-[#f1ebdf] pt-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted">PayPal ship-to address</dt>
                <dd className="mt-0.5">{paypalAddress ?? "None on file"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted">Payment capture</dt>
                <dd className="mt-0.5 break-all font-mono text-xs">{order.captureId ?? "Not captured"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted">Shipment</dt>
                <dd className="mt-0.5">
                  {ship ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>
                        {ship.carrier} <span className="font-mono text-xs">{ship.trackingNumber}</span> · {ship.status.replace("_", " ")}
                        {!ship.pushedToPaypal ? " · not on PayPal" : ship.pushSimulated ? " · Simulated push (not sent to PayPal)" : " · on PayPal"}
                      </span>
                      {ship.simulated || ship.pushSimulated ? <SimulatedTag /> : null}
                    </span>
                  ) : (
                    "Not shipped yet"
                  )}
                </dd>
              </div>
            </dl>
          </Panel>

          {order.source === "agent" ? <MandatePanel mandate={mandate} /> : null}

          <Panel title="Disputes">
            {disputes.length === 0 ? (
              <p className="text-sm text-muted">No disputes on this order.</p>
            ) : (
              <ul className="space-y-3">
                {disputes.map((d) => {
                  const chip = disputeStatusChip(d.status);
                  return (
                    <li key={d.id}>
                      <Link href={`/dashboard/disputes/${encodeURIComponent(d.id)}`} className="group block rounded-lg border border-[#ece5d6] p-3 hover:border-green/40">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge label={chip.label} tone={chip.tone} size="sm" />
                          {d.simulated ? <SimulatedTag /> : null}
                        </div>
                        <p className="mt-1.5 text-sm font-medium group-hover:text-green">{reasonLabel(d.reason)}</p>
                        <p className="text-xs text-muted">Open the case &rarr;</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
