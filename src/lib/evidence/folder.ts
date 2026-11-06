import { eq, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { disputes, mandates, messages, orders, shipments } from "@/lib/db/schema";
import { STORE_POLICY } from "@/lib/store-policy";

export type EvidenceKind =
  | "order" | "capture" | "ship_address" | "tracking" | "delivery" | "signature"
  | "buyer_message" | "policy_at_checkout" | "mandate" | "payer_approval" | "agent_identity" | "refund" | "dispute";

export type EvidenceItem = {
  id: string;
  kind: EvidenceKind;
  title: string;
  at: string | null;
  summary: string;
  data: unknown;
  source: "paypal" | "seller_shield" | "storefront" | "demo_carrier" | "mandate";
  simulated: boolean;
};

type Addr = { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; countryCode?: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | string | null | undefined) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};

function money(cents: number, currency: string): string {
  const v = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${v}` : `${v} ${currency}`;
}

function addrLine(a: Addr | null | undefined): string | null {
  if (!a) return null;
  const cityState = [a.city, a.state].filter(Boolean).join(", ");
  const line = [cityState, a.postalCode].filter(Boolean).join(" ");
  return line || null;
}

function fullAddr(a: Addr): string {
  return [a.line1, a.line2, addrLine(a), a.countryCode].filter(Boolean).join(", ");
}

/** Builds the evidence folder. Ids are stable (`ev:<kind>:<record id>`); items are sorted by `at`, nulls last. */
export async function buildEvidenceFolder(
  db: Db,
  input: { orderId: string | null; disputeId?: string },
): Promise<EvidenceItem[]> {
  const items: EvidenceItem[] = [];

  if (input.orderId) await addOrderItems(db, input.orderId, items);
  if (input.disputeId) await addDisputeItems(db, input.disputeId, items);

  return items.sort((a, b) => {
    if (a.at === b.at) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at < b.at ? -1 : 1;
  });
}

async function addOrderItems(db: Db, orderId: string, items: EvidenceItem[]) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return;

  const lines = (Array.isArray(o.items) ? (o.items as { sku?: string; name?: string; qty?: number }[]) : [])
    .map((i) => `${i.qty ?? 1} x ${i.name ?? i.sku ?? "item"}`)
    .join(", ");
  items.push({
    id: `ev:order:${o.id}`, kind: "order", title: "Order", at: iso(o.createdAt), source: "storefront", simulated: false,
    summary: `Order ${o.id} placed ${day(o.createdAt)} for ${money(o.amountCents, o.currency)}: ${lines || "no item lines recorded"}`,
    data: { id: o.id, source: o.source, status: o.status, amountCents: o.amountCents, currency: o.currency, items: o.items },
  });

  if (o.captureId) {
    items.push({
      id: `ev:capture:${o.captureId}`, kind: "capture", title: "Payment capture", at: iso(o.approvedAt ?? o.createdAt),
      source: "paypal", simulated: false,
      summary: `PayPal payment of ${money(o.amountCents, o.currency)} captured (capture ${o.captureId}) for order ${o.id}`,
      data: { captureId: o.captureId, orderId: o.id, amountCents: o.amountCents, currency: o.currency, payerId: o.payerId },
    });
  }

  const shipAddr = (o.shipAddress ?? null) as Addr | null;
  if (shipAddr) {
    items.push({
      id: `ev:ship_address:${o.id}`, kind: "ship_address", title: "Shipping address on the PayPal transaction",
      at: iso(o.approvedAt ?? o.createdAt), source: "paypal", simulated: false,
      summary: `Shipping address on the PayPal transaction: ${o.shipName ? `${o.shipName}, ` : ""}${fullAddr(shipAddr)}`,
      data: { name: o.shipName, address: shipAddr },
    });
  }

  items.push({
    id: `ev:policy_at_checkout:${o.id}`, kind: "policy_at_checkout", title: "Store policy at checkout", at: iso(o.createdAt),
    source: "seller_shield", simulated: false,
    summary: `Store policy version ${STORE_POLICY.version}. Returns: ${STORE_POLICY.returns} Shipping: ${STORE_POLICY.shipping}`,
    data: STORE_POLICY,
  });

  const ships = await db.select().from(shipments).where(eq(shipments.orderId, o.id));
  for (const s of ships) {
    const source = s.simulated ? "demo_carrier" : "seller_shield";
    const pushed = !s.pushedToPaypal
      ? "tracking not pushed to PayPal"
      : s.pushSimulated
        ? `Simulated push to PayPal ${day(s.pushedAt) ?? "(date not recorded)"} (not sent to PayPal)`
        : `tracking pushed to PayPal ${day(s.pushedAt) ?? "(date not recorded)"}`;
    items.push({
      id: `ev:tracking:${s.id}`, kind: "tracking", title: "Tracking", at: iso(s.pushedAt ?? o.createdAt), source,
      simulated: s.simulated || (s.pushedToPaypal && s.pushSimulated),
      summary: `${s.carrier} tracking ${s.trackingNumber}, status ${s.status}; ${pushed}`,
      data: { shipmentId: s.id, carrier: s.carrier, trackingNumber: s.trackingNumber, status: s.status, pushedToPaypal: s.pushedToPaypal, pushSimulated: s.pushSimulated, pushedAt: iso(s.pushedAt), signatureRequired: s.signatureRequired },
    });
    if (s.status === "delivered" && s.deliveredAt) {
      const to = addrLine((s.shipToAddress ?? shipAddr) as Addr | null);
      items.push({
        id: `ev:delivery:${s.id}`, kind: "delivery", title: "Delivery", at: iso(s.deliveredAt), source, simulated: s.simulated,
        summary: `Delivered ${day(s.deliveredAt)}${to ? ` to ${to}` : ""} (${s.carrier} ${s.trackingNumber})`,
        data: { shipmentId: s.id, deliveredAt: iso(s.deliveredAt), shipToAddress: s.shipToAddress ?? shipAddr },
      });
    }
  }

  const msgs = await db.select().from(messages).where(eq(messages.orderId, o.id));
  for (const m of msgs.filter((x) => x.source === "storefront")) {
    items.push({
      id: `ev:buyer_message:${m.id}`, kind: "buyer_message", title: `Storefront message from ${m.author}`, at: iso(m.createdAt),
      source: "storefront", simulated: false,
      summary: `Storefront message from ${m.author} on ${day(m.createdAt)}: "${m.body}"`,
      data: { id: m.id, author: m.author, body: m.body },
    });
  }

  const [mandate] = await db.select().from(mandates).where(
    o.mandateId ? or(eq(mandates.id, o.mandateId), eq(mandates.orderId, o.id)) : eq(mandates.orderId, o.id),
  );
  if (mandate) addMandateItems(mandate, o, items);
}

type ReadMandate = {
  mandateId: string; shopperEmail: string; agentId: string; items: { sku: string; qty: number }[];
  maxAmountCents: number; currency: string; createdAt: string; expiresAt: string;
};

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const validDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(new Date(v).getTime());

/** Returns the payload only if every field the summary uses is present and well-typed. */
function readPayload(raw: unknown): ReadMandate | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!isStr(p.mandateId) || !isStr(p.shopperEmail) || !isStr(p.agentId) || !isStr(p.currency)) return null;
  if (typeof p.maxAmountCents !== "number" || !Number.isFinite(p.maxAmountCents)) return null;
  if (!validDate(p.createdAt) || !validDate(p.expiresAt)) return null;
  if (!Array.isArray(p.items)) return null;
  for (const i of p.items) {
    if (!i || typeof i !== "object" || !isStr((i as { sku?: unknown }).sku) || typeof (i as { qty?: unknown }).qty !== "number") return null;
  }
  return p as unknown as ReadMandate;
}

function addMandateItems(
  mandate: typeof mandates.$inferSelect,
  o: typeof orders.$inferSelect,
  items: EvidenceItem[],
) {
  const p = readPayload(mandate.payload);
  const failures = Array.isArray(mandate.failures) ? (mandate.failures as string[]) : [];
  const verifiedText = mandate.verified
    ? "verified: true"
    : `verified: false (failures: ${failures.length ? failures.join(", ") : "none recorded"})`;
  const rawId = (mandate.payload as { mandateId?: unknown } | null)?.mandateId;
  const label = isStr(rawId) ? rawId : "unknown";
  const customIdText =
    mandate.paypalCustomIdMatch === true ? `PayPal order custom_id = ${mandate.hash} (matches)`
    : mandate.paypalCustomIdMatch === false ? "PayPal order custom_id (does not match the mandate hash)"
    : "PayPal order custom_id (not checked)";

  items.push({
    id: `ev:mandate:${mandate.id}`, kind: "mandate", title: "Purchase mandate",
    at: p ? p.createdAt : null, source: "mandate", simulated: false,
    summary: p
      ? `Mandate ${p.mandateId} for ${p.shopperEmail}: max ${money(p.maxAmountCents, p.currency)}, items ${p.items.map((i) => `${i.qty} x ${i.sku}`).join(", ")}, created ${day(p.createdAt)}, expires ${day(p.expiresAt)}; ${verifiedText}; hash ${mandate.hash}; ${customIdText}`
      : `Mandate ${label}: payload unreadable — not verified; ${customIdText}`,
    data: { payload: mandate.payload, hash: mandate.hash, verified: mandate.verified, failures, paypalCustomIdMatch: mandate.paypalCustomIdMatch },
  });

  const match = mandate.payerEmailMatch;
  const matchText =
    match === true ? "PayPal payer email matched the mandate shopper email"
    : match === false ? "PayPal payer email did not match the mandate shopper email"
    : "PayPal payer email match was not recorded";
  items.push({
    id: `ev:payer_approval:${o.id}`, kind: "payer_approval", title: "PayPal payer approval",
    at: iso(o.approvedAt), source: "paypal", simulated: false,
    summary: o.approvedAt
      ? `Payer approved the PayPal order on ${day(o.approvedAt)}; ${matchText}`
      : `No payer approval time recorded; ${matchText}`,
    data: { approvedAt: iso(o.approvedAt), payerId: o.payerId, payerEmailMatch: match },
  });

  // Tri-state: verifyMandate exits early (before checking the agent signature) on a bad shopper
  // signature or malformed mandate, so absence of the agent codes does not mean the agent was checked.
  const agentFailed = failures.includes("bad_agent_signature") || failures.includes("agent_not_named");
  const earlyExit = failures.includes("bad_shopper_signature") || failures.includes("malformed_mandate");
  const agentSig: "verified" | "failed" | "not checked" =
    agentFailed ? "failed"
    : mandate.verified || (failures.length > 0 && !earlyExit) ? "verified"
    : "not checked";
  const rawAgent = (mandate.payload as { agentId?: unknown } | null)?.agentId;
  const agentId = isStr(rawAgent) ? rawAgent : null;
  items.push({
    id: `ev:agent_identity:${mandate.id}`, kind: "agent_identity", title: "Agent identity", at: p ? p.createdAt : null,
    source: "mandate", simulated: false,
    summary: `Order placed by agent ${agentId ?? "unknown"}; agent request signature ${agentSig === "not checked" ? "not checked" : `verified: ${agentSig === "verified"}`}`,
    data: { agentId, agentSignature: agentSig },
  });
}

async function addDisputeItems(db: Db, disputeId: string, items: EvidenceItem[]) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  if (!d) return;
  const raw = (d.raw ?? {}) as { create_time?: string };

  items.push({
    id: `ev:capture:${d.id}:disputed`, kind: "capture", title: "Disputed transaction", at: raw.create_time ?? null,
    source: "paypal", simulated: d.simulated,
    summary: `Dispute ${d.id} (${d.reason}) opened${raw.create_time ? ` ${day(raw.create_time)}` : ""} for ${money(d.amountCents, d.currency)}${d.captureId ? ` on capture ${d.captureId}` : ""}`,
    data: { disputeId: d.id, captureId: d.captureId, reason: d.reason, status: d.status, amountCents: d.amountCents, currency: d.currency },
  });

  const msgs = await db.select().from(messages).where(eq(messages.disputeId, d.id));
  for (const m of msgs.filter((x) => x.source === "paypal_dispute")) {
    items.push({
      id: `ev:buyer_message:${m.id}`, kind: "buyer_message", title: `Dispute message from ${m.author}`, at: iso(m.createdAt),
      source: "paypal", simulated: d.simulated,
      summary: `Dispute message from ${m.author} on ${day(m.createdAt)}: "${m.body}"`,
      data: { id: m.id, author: m.author, body: m.body },
    });
  }
}
