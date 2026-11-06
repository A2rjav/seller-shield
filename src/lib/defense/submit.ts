import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cases, disputes } from "@/lib/db/schema";
import { REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import { ingestDispute } from "@/lib/disputes/ingest";
import * as paypalDisputes from "@/lib/paypal/disputes";
import { caseId, resolveReason, type StoredRecommendation } from "./build-case";
import { validateClaims, type CaseDraft } from "./case";

export type SubmitResult = { submitted: boolean; simulated?: boolean; paypalStatus?: string; error?: string };
export type SubmitApi = Pick<typeof paypalDisputes, "provideEvidence" | "makeOffer" | "acceptClaim" | "getDispute">;
type Deps = { api?: SubmitApi };

const DEFAULT_ACCEPT_NOTE = "I accept this claim and will refund the buyer.";
const DEFAULT_OFFER_NOTE = "I would like to resolve this with a partial refund.";

const NEED_CONFIRM = "Seller confirmation is required before anything is sent to PayPal.";
const refuse = (error: string): SubmitResult => ({ submitted: false, error });
const confirmed = (body: unknown) => !!body && typeof body === "object" && (body as { sellerConfirmed?: unknown }).sellerConfirmed === true;

async function loadDispute(db: Db, disputeId: string) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  return d;
}

const isResolved = (status: string) => status.toUpperCase() === "RESOLVED";

/** Fetch the fresh dispute from PayPal and fold it into our DB. */
async function refresh(db: Db, api: SubmitApi, disputeId: string): Promise<string | undefined> {
  const fresh = await api.getDispute(disputeId);
  const t = fresh.update_time ? new Date(fresh.update_time) : new Date();
  await ingestDispute(db, fresh, { eventTime: Number.isNaN(t.getTime()) ? new Date() : t });
  return fresh.status;
}

const LOCK_TTL_SECONDS = 60;
const BUSY = "Another action is in progress for this dispute. Try again in a moment.";

/**
 * Atomically claims the case row for one seller action (placeholder row created if no case was built yet),
 * runs `fn`, and always releases. A claim older than 60s is treated as stale.
 */
async function withActionLock(db: Db, disputeId: string, fn: () => Promise<SubmitResult>): Promise<SubmitResult> {
  const id = caseId(disputeId);
  await db.insert(cases).values({ id, disputeId, builtAt: new Date(0) }).onConflictDoNothing();
  const claimed = await db
    .update(cases)
    .set({ actionInFlightAt: sql`now()` })
    .where(and(eq(cases.id, id), or(isNull(cases.actionInFlightAt), lt(cases.actionInFlightAt, sql`now() - interval '${sql.raw(String(LOCK_TTL_SECONDS))} seconds'`))))
    .returning({ id: cases.id });
  if (claimed.length === 0) return refuse(BUSY);
  try {
    return await fn();
  } finally {
    await db.update(cases).set({ actionInFlightAt: null }).where(eq(cases.id, id));
  }
}

async function loadCase(db: Db, disputeId: string) {
  const [row] = await db.select().from(cases).where(eq(cases.id, caseId(disputeId)));
  return row;
}

type PriorResult = { action?: string; disputeStatus?: string } | null;

/** Submits the stored evidence PDF to PayPal. Never runs without `sellerConfirmed: true`; at most once per case. */
export async function submitCase(db: Db, disputeId: string, body: unknown, deps: Deps = {}): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse(NEED_CONFIRM);
  const api = deps.api ?? paypalDisputes;
  if (!(await loadDispute(db, disputeId))) return refuse("Dispute not found.");

  return withActionLock(db, disputeId, async () => {
    const dispute = (await loadDispute(db, disputeId))!;
    if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");
    const row = await loadCase(db, disputeId);
    if (!row || !row.draft || !row.pdfBytes) return refuse("No case has been built for this dispute yet.");
    if (row.submittedAt) return refuse("Evidence already submitted for this dispute.");

    const stored = row.recommendation as StoredRecommendation | null;
    const check = validateClaims(row.draft as CaseDraft, Array.isArray(stored?.evidence) ? stored.evidence : []);
    if (!check.ok) return refuse(`The case cites evidence that is not in the folder: ${check.problems.join("; ")}`);

    if (dispute.simulated) {
      await db.update(cases).set({ submittedAt: new Date(), submitResult: { simulated: true, action: "evidence" } }).where(eq(cases.id, row.id));
      return { submitted: true, simulated: true };
    }

    const draft = row.draft as CaseDraft;
    const notes = [draft.summary, draft.sellerNote].filter(Boolean).join("\n\n").slice(0, 2000) || "Evidence attached.";
    const evidenceType = REASON_REQUIREMENTS[resolveReason(dispute.reason)].paypalEvidenceType;
    try {
      await api.provideEvidence(disputeId, { notes, evidenceType, pdf: row.pdfBytes });
    } catch (err) {
      return refuse(`PayPal rejected the submission: ${err instanceof Error ? err.message : "error"}`);
    }
    await db.update(cases).set({ submittedAt: new Date(), submitResult: { action: "evidence", evidenceType } }).where(eq(cases.id, row.id));
    return { submitted: true, paypalStatus: await tryRefresh(db, api, disputeId) };
  });
}

async function tryRefresh(db: Db, api: SubmitApi, disputeId: string): Promise<string | undefined> {
  try {
    return await refresh(db, api, disputeId);
  } catch {
    return undefined; // PayPal accepted the action; the status refresh happens on the next poll
  }
}

/** Offers the buyer a partial refund. Amount defaults to the stored recommendation's `offerCents`. */
export async function submitOffer(
  db: Db,
  disputeId: string,
  body: { sellerConfirmed?: unknown; amountCents?: unknown; note?: unknown },
  deps: Deps = {},
): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse(NEED_CONFIRM);
  const api = deps.api ?? paypalDisputes;
  if (!(await loadDispute(db, disputeId))) return refuse("Dispute not found.");

  return withActionLock(db, disputeId, async () => {
    const dispute = (await loadDispute(db, disputeId))!;
    if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");
    const row = await loadCase(db, disputeId);
    const prior = (row?.submitResult ?? null) as PriorResult;
    if (prior?.action === "offer" && prior.disputeStatus === dispute.status) {
      return refuse("An offer was already sent and the dispute has not changed since.");
    }

    let amountCents: unknown = body.amountCents;
    if (amountCents === undefined) {
      amountCents = (row?.recommendation as StoredRecommendation | null)?.offerCents;
      if (amountCents === undefined) return refuse("No offer amount: provide amountCents or build the case first.");
    }
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > dispute.amountCents) {
      return refuse(`Offer must be a whole number of cents between 1 and ${dispute.amountCents}.`);
    }

    if (dispute.simulated) {
      await db.update(cases).set({ submitResult: { simulated: true, action: "offer", disputeStatus: dispute.status, amountCents } }).where(eq(cases.id, caseId(disputeId)));
      return { submitted: true, simulated: true };
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : DEFAULT_OFFER_NOTE;
    try {
      await api.makeOffer(disputeId, { amountCents, currency: dispute.currency, note });
    } catch (err) {
      return refuse(`PayPal rejected the offer: ${err instanceof Error ? err.message : "error"}`);
    }
    const paypalStatus = await tryRefresh(db, api, disputeId);
    const after = (await loadDispute(db, disputeId)) ?? dispute;
    await db.update(cases).set({ submitResult: { action: "offer", disputeStatus: after.status, amountCents } }).where(eq(cases.id, caseId(disputeId)));
    return { submitted: true, paypalStatus };
  });
}

/** Accepts the buyer's claim (refund). Once only. */
export async function submitAccept(
  db: Db,
  disputeId: string,
  body: { sellerConfirmed?: unknown; note?: unknown },
  deps: Deps = {},
): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse(NEED_CONFIRM);
  const api = deps.api ?? paypalDisputes;
  if (!(await loadDispute(db, disputeId))) return refuse("Dispute not found.");

  return withActionLock(db, disputeId, async () => {
    const dispute = (await loadDispute(db, disputeId))!;
    if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");
    const row = await loadCase(db, disputeId);
    if (((row?.submitResult ?? null) as PriorResult)?.action === "accept") return refuse("The claim was already accepted.");

    if (dispute.simulated) {
      await db.update(cases).set({ submitResult: { simulated: true, action: "accept" } }).where(eq(cases.id, caseId(disputeId)));
      return { submitted: true, simulated: true };
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : DEFAULT_ACCEPT_NOTE;
    try {
      await api.acceptClaim(disputeId, note);
    } catch (err) {
      return refuse(`PayPal rejected the request: ${err instanceof Error ? err.message : "error"}`);
    }
    await db.update(cases).set({ submitResult: { action: "accept" } }).where(eq(cases.id, caseId(disputeId)));
    return { submitted: true, paypalStatus: await tryRefresh(db, api, disputeId) };
  });
}
