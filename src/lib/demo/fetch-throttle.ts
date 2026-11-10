import { and, eq, like, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { demoState } from "@/lib/db/schema";

export const FETCH_PER_DISPUTE_SEC = 15;
export const FETCH_GLOBAL_PER_MIN = 10;
const WINDOW_KEY = "fetch_window";
const disputeKey = (id: string) => `fetch:${id}`;

export type FetchClaim = { ok: true } | { ok: false; retryAfterSec: number };

const secondsLeft = (expr: ReturnType<typeof sql>) => sql<string>`extract(epoch from (${expr}))`;

/** Returns null when throttled, else whether this request inserted the row (the insert marks it `{fresh:true}`, an update clears the mark). */
async function claimDispute(db: Db, id: string): Promise<{ inserted: boolean } | null> {
  const rows = await db
    .insert(demoState)
    .values({ key: disputeKey(id), value: { fresh: true } })
    .onConflictDoUpdate({
      target: demoState.key,
      set: { updatedAt: sql`now()`, value: {} },
      setWhere: sql`${demoState.updatedAt} < now() - make_interval(secs => ${FETCH_PER_DISPUTE_SEC})`,
    })
    .returning({ value: demoState.value });
  if (!rows.length) return null;
  return { inserted: (rows[0].value as { fresh?: boolean } | null)?.fresh === true };
}

/** Per-id rows are only needed for 15 s; drop old ones so anonymous callers cannot grow the table. */
const pruneStale = (db: Db) =>
  db.delete(demoState).where(and(like(demoState.key, "fetch:%"), sql`${demoState.updatedAt} < now() - interval '1 hour'`));

/** Fixed one-minute window counter in one row: the update only applies while the window is expired or under the cap. */
async function claimGlobal(db: Db): Promise<boolean> {
  const expired = sql`${demoState.updatedAt} < now() - interval '1 minute'`;
  const rows = await db
    .insert(demoState)
    .values({ key: WINDOW_KEY, value: { n: 1 } })
    .onConflictDoUpdate({
      target: demoState.key,
      set: {
        value: sql`case when ${expired} then '{"n":1}'::jsonb else jsonb_build_object('n', (${demoState.value}->>'n')::int + 1) end`,
        updatedAt: sql`case when ${expired} then now() else ${demoState.updatedAt} end`,
      },
      setWhere: sql`${expired} or (${demoState.value}->>'n')::int < ${FETCH_GLOBAL_PER_MIN}`,
    })
    .returning({ key: demoState.key });
  return rows.length > 0;
}

async function leftSec(db: Db, key: string, intervalSql: ReturnType<typeof sql>): Promise<number> {
  const [row] = await db
    .select({ left: secondsLeft(sql`${demoState.updatedAt} + ${intervalSql} - now()`) })
    .from(demoState)
    .where(eq(demoState.key, key));
  return row ? Math.max(1, Math.ceil(Number(row.left))) : 1;
}

/**
 * Atomic, database-clock throttle for the dispute fetch: one PayPal fetch per dispute id per 15 s, and at most 10 per
 * minute overall. Holds across instances because every claim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE.
 */
export async function claimDisputeFetch(db: Db, id: string): Promise<FetchClaim> {
  await pruneStale(db).catch(() => {});
  const claimed = await claimDispute(db, id);
  if (!claimed) {
    return { ok: false, retryAfterSec: await leftSec(db, disputeKey(id), sql`make_interval(secs => ${FETCH_PER_DISPUTE_SEC})`) };
  }
  if (!(await claimGlobal(db))) {
    // The global cap refused: do not make this dispute id wait out its own 15 s for a fetch that never happened.
    // A row this request inserted is removed; one that pre-existed was already past its 15 s, so it is marked expired again.
    if (claimed.inserted) await db.delete(demoState).where(eq(demoState.key, disputeKey(id)));
    else await db.update(demoState).set({ updatedAt: sql`now() - interval '1 day'` }).where(eq(demoState.key, disputeKey(id)));
    return { ok: false, retryAfterSec: await leftSec(db, WINDOW_KEY, sql`interval '1 minute'`) };
  }
  return { ok: true };
}
