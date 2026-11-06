import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { disputes, messages, orders, webhookEvents } from "@/lib/db/schema";
import { disputeAmount, type PaypalDispute } from "@/lib/paypal/disputes";

export type WebhookEvent = { id: string; event_type: string; create_time: string; resource: unknown };
export type IngestResult = { created: boolean; changed: boolean };

const AUTHOR = { BUYER: "buyer", SELLER: "seller", ARBITER: "paypal" } as const;

const date = (v: string | undefined) => (v ? new Date(v) : null);

/** Upserts a dispute. A stale event (older than stored lastEventAt) is ignored. */
export async function ingestDispute(
  db: Db,
  d: PaypalDispute,
  opts: { eventTime: Date; simulated?: boolean },
): Promise<IngestResult> {
  const [existing] = await db.select().from(disputes).where(eq(disputes.id, d.dispute_id));
  if (existing?.lastEventAt && opts.eventTime.getTime() < existing.lastEventAt.getTime()) {
    return { created: false, changed: false };
  }

  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id ?? null;
  let orderId: string | null = existing?.orderId ?? null;
  if (!orderId && captureId) {
    const [o] = await db.select({ id: orders.id }).from(orders).where(eq(orders.captureId, captureId));
    orderId = o?.id ?? null;
  }

  const { amountCents, currency } = disputeAmount(d);
  const values = {
    orderId,
    captureId,
    reason: d.reason,
    status: d.status,
    stage: d.dispute_life_cycle_stage,
    amountCents,
    currency,
    sellerResponseDue: date(d.seller_response_due_date),
    simulated: opts.simulated ?? existing?.simulated ?? false,
    outcome: d.dispute_outcome?.outcome_code ?? null,
    lastEventAt: opts.eventTime,
    raw: d,
  };

  let changed: boolean;
  if (existing) {
    changed =
      existing.status !== values.status ||
      existing.stage !== values.stage ||
      existing.outcome !== values.outcome ||
      existing.orderId !== values.orderId ||
      existing.amountCents !== values.amountCents ||
      (existing.sellerResponseDue?.getTime() ?? null) !== (values.sellerResponseDue?.getTime() ?? null);
    await db.update(disputes).set(values).where(eq(disputes.id, d.dispute_id));
  } else {
    changed = true;
    await db.insert(disputes).values({ id: d.dispute_id, ...values });
  }

  for (const m of d.messages ?? []) {
    await db
      .insert(messages)
      .values({
        id: `${d.dispute_id}:${m.posted_by}:${m.time_posted}`,
        orderId,
        disputeId: d.dispute_id,
        author: AUTHOR[m.posted_by] ?? "paypal",
        body: m.content,
        createdAt: new Date(m.time_posted),
        source: "paypal_dispute",
      })
      .onConflictDoNothing();
  }
  return { created: !existing, changed };
}

const DISPUTE_EVENTS = new Set(["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"]);
const RECORD_ONLY_EVENTS = new Set(["PAYMENT.CAPTURE.COMPLETED", "CHECKOUT.ORDER.APPROVED"]);

export async function handleWebhookEvent(db: Db, evt: WebhookEvent): Promise<"ignored" | "duplicate" | "processed"> {
  const isDispute = DISPUTE_EVENTS.has(evt.event_type);
  if (!isDispute && !RECORD_ONLY_EVENTS.has(evt.event_type)) return "ignored";

  // Dedupe record and processing commit or roll back together: a crash or error leaves no
  // webhook_events row, so PayPal's retry is processed; a concurrent retry waits on the unique
  // key until this transaction ends, then sees the committed row and reports "duplicate".
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvents)
      .values({ id: evt.id, type: evt.event_type })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) return "duplicate" as const;

    if (isDispute) {
      const d = evt.resource as PaypalDispute;
      if (!d || typeof d.dispute_id !== "string") throw new Error("Dispute webhook resource has no dispute_id");
      const eventTime = new Date(d.update_time ?? evt.create_time);
      await ingestDispute(tx as unknown as Db, d, { eventTime });
    }
    return "processed" as const;
  });
}

type PollApi = {
  listDisputes(): Promise<PaypalDispute[]>;
  getDispute(id: string): Promise<PaypalDispute>;
};

/** Polling fallback: list summaries, fetch the full dispute only when new or newer than stored. */
export async function pollDisputes(db: Db, api: PollApi): Promise<{ checked: number; created: number; changed: number }> {
  const items = await api.listDisputes();
  const ids = items.map((i) => i.dispute_id);
  const stored = ids.length
    ? await db.select({ id: disputes.id, lastEventAt: disputes.lastEventAt }).from(disputes).where(inArray(disputes.id, ids))
    : [];
  const lastById = new Map(stored.map((s) => [s.id, s.lastEventAt]));

  let created = 0;
  let changed = 0;
  for (const item of items) {
    const has = lastById.has(item.dispute_id);
    const last = lastById.get(item.dispute_id);
    const updated = item.update_time ? new Date(item.update_time) : null;
    const fresh = !has || !last || !updated || updated.getTime() > last.getTime();
    if (!fresh) continue;
    const full = await api.getDispute(item.dispute_id);
    const r = await ingestDispute(db, full, { eventTime: new Date(full.update_time ?? item.update_time ?? Date.now()) });
    if (r.created) created++;
    if (r.changed) changed++;
  }
  return { checked: items.length, created, changed };
}
