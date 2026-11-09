import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { disputes } from "@/lib/db/schema";
import { ingestDispute } from "@/lib/disputes/ingest";
import { PaypalError } from "@/lib/paypal/client";
import type { PaypalDispute } from "@/lib/paypal/disputes";
import { DemoError } from "./simulate";

/** PayPal dispute ids as the sandbox shows them: PP-R-... (opened as an inquiry) or PP-D-... (a dispute). */
export const DISPUTE_ID = /^PP-[RD]-[A-Z0-9][A-Z0-9-]{2,40}$/;
export const fetchDisputeBody = z
  .object({ disputeId: z.string().trim().toUpperCase().pipe(z.string().regex(DISPUTE_ID)) })
  .strict();

/**
 * Fetches one real dispute from PayPal by id and stores it, without waiting for PayPal's list (which lags several
 * minutes behind a new dispute). Read-only on PayPal's side.
 */
export async function fetchAndIngestDispute(db: Db, disputeId: string, deps: { getDispute: (id: string) => Promise<PaypalDispute> }) {
  let d: PaypalDispute;
  try {
    d = await deps.getDispute(disputeId);
  } catch (e) {
    if (e instanceof PaypalError && (e.status === 404 || e.status === 403)) {
      throw new DemoError(404, "PayPal has no dispute with that ID for this seller. Check the ID PayPal showed the buyer.");
    }
    throw e;
  }
  if (!d?.dispute_id) throw new Error("PayPal returned an unreadable dispute.");
  const r = await ingestDispute(db, d, { eventTime: new Date(d.update_time ?? Date.now()) });
  const [row] = await db.select().from(disputes).where(eq(disputes.id, d.dispute_id));
  return {
    dispute: { id: d.dispute_id, status: row?.status ?? d.status, stage: row?.stage ?? d.dispute_life_cycle_stage, reason: d.reason, orderId: row?.orderId ?? null },
    created: r.created,
    changed: r.changed,
  };
}
