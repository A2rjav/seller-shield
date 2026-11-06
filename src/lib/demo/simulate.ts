import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { disputes, messages, orders } from "@/lib/db/schema";
import { ingestDispute } from "@/lib/disputes/ingest";
import type { PaypalDispute } from "@/lib/paypal/disputes";

/** A demo-endpoint failure that maps straight to an HTTP status and a message fit to show a judge. */
export class DemoError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export const SIM_REASONS = ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "UNAUTHORISED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"] as const;
export type SimReason = (typeof SIM_REASONS)[number];
export type Outcome = "SELLER_FAVOR" | "BUYER_FAVOR";

const BUYER_LINE: Record<SimReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "[Demo dispute] My order never arrived. The tracking shows nothing at my door.",
  UNAUTHORISED: "[Demo dispute] I did not authorise this payment. I do not recognise this purchase.",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "[Demo dispute] What I received is not what the listing described.",
};

const DAY = 86_400_000;
export const SIM_RESPONSE_DAYS = 10;

function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === "object" ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

const ALREADY_OPEN = new DemoError(409, "This order already has an open simulated dispute. Resolve it first, or pick another order.");

/** Opens a clearly simulated dispute (id `SIM-...`) on an order. At most one open simulated dispute per order. */
export async function createSimulatedDispute(db: Db, orderId: string, reason: SimReason, now: Date = new Date()) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DemoError(404, "Order not found.");
  const [open] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.orderId, orderId), eq(disputes.simulated, true), ne(disputes.status, "RESOLVED")));
  if (open) throw ALREADY_OPEN;

  const id = `SIM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(disputes)
        .values({
          id,
          orderId,
          captureId: order.captureId,
          reason,
          status: "WAITING_FOR_SELLER_RESPONSE",
          stage: reason === "UNAUTHORISED" ? "CHARGEBACK" : "INQUIRY",
          amountCents: order.amountCents,
          currency: order.currency,
          sellerResponseDue: new Date(now.getTime() + SIM_RESPONSE_DAYS * DAY),
          simulated: true,
          lastEventAt: now,
          raw: { dispute_id: id, simulated: true, create_time: now.toISOString() },
        })
        .returning();
      await tx.insert(messages).values({
        id: `msg_${id}`,
        orderId,
        disputeId: id,
        author: "buyer",
        source: "paypal_dispute",
        body: BUYER_LINE[reason],
        createdAt: now,
      });
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw ALREADY_OPEN;
    throw e;
  }
}

export type ResolveDeps = {
  adjudicate: (id: string, outcome: Outcome) => Promise<void>;
  getDispute: (id: string) => Promise<PaypalDispute>;
};

const OUTCOME_CODE: Record<Outcome, string> = { SELLER_FAVOR: "RESOLVED_SELLER_FAVOUR", BUYER_FAVOR: "RESOLVED_BUYER_FAVOUR" };

/** PayPal's sandbox only settles a dispute that is under review (after the seller has answered). */
const ADJUDICATABLE = new Set(["UNDER_REVIEW"]);

/**
 * Settles a dispute. Simulated disputes are closed locally (nothing is sent to PayPal). Real sandbox disputes go to
 * PayPal's sandbox adjudicate, only when PayPal says the dispute is in a state that allows it, then are re-ingested.
 */
export async function resolveDispute(db: Db, input: { disputeId: string; outcome: Outcome }, deps: ResolveDeps) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, input.disputeId));
  if (!d) throw new DemoError(404, "Dispute not found.");
  if (d.status.toUpperCase() === "RESOLVED") throw new DemoError(409, "This dispute is already resolved.");
  const outcome = OUTCOME_CODE[input.outcome];

  if (d.simulated) {
    await db.update(disputes).set({ status: "RESOLVED", outcome, lastEventAt: new Date() }).where(eq(disputes.id, d.id));
    return { disputeId: d.id, simulated: true, outcome };
  }

  const live = await deps.getDispute(d.id);
  if (!ADJUDICATABLE.has(live.status.toUpperCase())) {
    const state = live.status.toLowerCase().replace(/_/g, " ");
    throw new DemoError(409, `PayPal's sandbox can only settle a dispute that is under review; this one is "${state}". Submit your evidence first, then resolve it.`);
  }
  await deps.adjudicate(d.id, input.outcome);
  const after = await deps.getDispute(d.id);
  await ingestDispute(db, after, { eventTime: new Date(after.update_time ?? Date.now()) });
  const [row] = await db.select().from(disputes).where(eq(disputes.id, d.id));
  return { disputeId: d.id, simulated: false, outcome: row?.outcome ?? outcome };
}
