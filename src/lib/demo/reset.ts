import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cases, demoState, disputes, mandates, messages, orders, protectionChecks, shipments } from "@/lib/db/schema";
import { loadBaseline } from "./baseline";
import { seedDemo, type SeedDeps, type SeedResult } from "./seed";

const KEY = "last_reset";
export const RESET_COOLDOWN_SEC = 120;

/** Seconds until a reset is allowed again (0 when it is allowed now). Uses the database clock, like the claim. */
export async function resetCooldownSec(db: Db): Promise<number> {
  const [row] = await db
    .select({ left: sql<string>`extract(epoch from (${demoState.updatedAt} + interval '2 minutes' - now()))` })
    .from(demoState)
    .where(eq(demoState.key, KEY));
  return row ? Math.max(0, Math.ceil(Number(row.left))) : 0;
}

/** Atomic global claim: one INSERT ... ON CONFLICT DO UPDATE ... WHERE, so concurrent resets cannot both win. */
async function claimReset(db: Db): Promise<boolean> {
  const rows = await db
    .insert(demoState)
    .values({ key: KEY, value: {} })
    .onConflictDoUpdate({
      target: demoState.key,
      set: { updatedAt: sql`now()` },
      setWhere: sql`${demoState.updatedAt} < now() - interval '2 minutes'`,
    })
    .returning({ key: demoState.key });
  return rows.length > 0;
}

const releaseClaim = (db: Db) =>
  db.update(demoState).set({ updatedAt: sql`now() - interval '1 day'` }).where(eq(demoState.key, KEY));

export type ResetResult =
  | ({ ok: true; deleted: { orders: number; disputes: number } } & SeedResult)
  | { ok: false; retryAfterSec: number };

/** Deletes every local row a judge created (PayPal-side data is never touched) and resets the baseline orders' local scenario data. */
async function wipeJudgeData(tx: Db, baseline: string[]) {
  const allOrders = await tx.select({ id: orders.id, mandateId: orders.mandateId }).from(orders);
  const base = new Set(baseline);
  const judge = allOrders.filter((o) => !base.has(o.id)).map((o) => o.id);
  const judgeSet = new Set(judge);
  const keepMandates = allOrders.filter((o) => base.has(o.id) && o.mandateId).map((o) => o.mandateId as string);

  const ds = await tx.select({ id: disputes.id, orderId: disputes.orderId, simulated: disputes.simulated }).from(disputes);
  const dIds = ds.filter((d) => d.simulated || (d.orderId !== null && judgeSet.has(d.orderId))).map((d) => d.id);
  if (dIds.length) {
    await tx.delete(cases).where(inArray(cases.disputeId, dIds));
    await tx.delete(messages).where(inArray(messages.disputeId, dIds));
    await tx.delete(disputes).where(inArray(disputes.id, dIds));
  }
  if (judge.length) {
    await tx.delete(protectionChecks).where(inArray(protectionChecks.orderId, judge));
    await tx.delete(messages).where(inArray(messages.orderId, judge));
    await tx.delete(shipments).where(inArray(shipments.orderId, judge));
    await tx.delete(orders).where(inArray(orders.id, judge));
  }
  // Judge mandates: those of deleted orders, and ones never attached to an order. Baseline orders' mandates stay.
  const notKept = keepMandates.length ? notInArray(mandates.id, keepMandates) : undefined;
  const mandateWhere = judge.length ? sql`(${isNull(mandates.orderId)} or ${inArray(mandates.orderId, judge)})` : isNull(mandates.orderId);
  await tx.delete(mandates).where(notKept ? and(notKept, mandateWhere) : mandateWhere);

  if (baseline.length) {
    await tx.delete(messages).where(and(inArray(messages.orderId, baseline), isNull(messages.disputeId)));
    await tx.delete(protectionChecks).where(inArray(protectionChecks.orderId, baseline));
    // Tracking already on PayPal stays (it is PayPal-side data); only its local delivery state is rewound.
    await tx.delete(shipments).where(and(inArray(shipments.orderId, baseline), eq(shipments.pushedToPaypal, false)));
    await tx
      .update(shipments)
      .set({ status: "in_transit", deliveredAt: null, simulated: false })
      .where(inArray(shipments.orderId, baseline));
  }
  return { orders: judge.length, disputes: dIds.length };
}

/** Rate-limited (once per 2 minutes, globally) reset of the shared demo. Seed re-reads baseline orders from PayPal (GET only). */
export async function resetDemo(db: Db, deps: SeedDeps): Promise<ResetResult> {
  if (!(await claimReset(db))) return { ok: false, retryAfterSec: Math.max(1, await resetCooldownSec(db)) };
  try {
    const entries = deps.entries ?? loadBaseline();
    const deleted = await db.transaction((tx) => wipeJudgeData(tx as unknown as Db, entries.map((e) => e.orderId)));
    const seeded = await seedDemo(db, { ...deps, entries });
    return { ok: true, deleted, ...seeded };
  } catch (e) {
    await releaseClaim(db).catch(() => {});
    throw e;
  }
}
