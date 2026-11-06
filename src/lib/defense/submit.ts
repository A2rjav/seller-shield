import { eq } from "drizzle-orm";
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

/** Submits the stored evidence PDF to PayPal. Never runs without `sellerConfirmed: true`. */
export async function submitCase(db: Db, disputeId: string, body: unknown, deps: Deps = {}): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse("Seller confirmation is required before anything is sent to PayPal.");
  const api = deps.api ?? paypalDisputes;

  const dispute = await loadDispute(db, disputeId);
  if (!dispute) return refuse("Dispute not found.");
  if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");

  const [row] = await db.select().from(cases).where(eq(cases.id, caseId(disputeId)));
  if (!row || !row.draft || !row.pdfBytes) return refuse("No case has been built for this dispute yet.");

  const stored = row.recommendation as StoredRecommendation | null;
  const check = validateClaims(row.draft as CaseDraft, Array.isArray(stored?.evidence) ? stored.evidence : []);
  if (!check.ok) return refuse(`The case cites evidence that is not in the folder: ${check.problems.join("; ")}`);

  if (dispute.simulated) {
    await db.update(cases).set({ submittedAt: new Date(), submitResult: { simulated: true } }).where(eq(cases.id, row.id));
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
  await db.update(cases).set({ submittedAt: new Date(), submitResult: { evidenceType } }).where(eq(cases.id, row.id));
  let paypalStatus: string | undefined;
  try {
    paypalStatus = await refresh(db, api, disputeId);
  } catch {
    // evidence was accepted; the status refresh can happen on the next poll
  }
  return { submitted: true, paypalStatus };
}

/** Offers the buyer a partial refund. Amount defaults to the stored recommendation's `offerCents`. */
export async function submitOffer(
  db: Db,
  disputeId: string,
  body: { sellerConfirmed?: unknown; amountCents?: unknown; note?: unknown },
  deps: Deps = {},
): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse("Seller confirmation is required before anything is sent to PayPal.");
  const api = deps.api ?? paypalDisputes;
  const dispute = await loadDispute(db, disputeId);
  if (!dispute) return refuse("Dispute not found.");
  if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");

  let amountCents: unknown = body.amountCents;
  if (amountCents === undefined) {
    const [row] = await db.select().from(cases).where(eq(cases.id, caseId(disputeId)));
    amountCents = (row?.recommendation as StoredRecommendation | null)?.offerCents;
    if (amountCents === undefined) return refuse("No offer amount: provide amountCents or build the case first.");
  }
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > dispute.amountCents) {
    return refuse(`Offer must be a whole number of cents between 1 and ${dispute.amountCents}.`);
  }

  if (dispute.simulated) return { submitted: true, simulated: true };
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : DEFAULT_OFFER_NOTE;
  try {
    await api.makeOffer(disputeId, { amountCents, currency: dispute.currency, note });
  } catch (err) {
    return refuse(`PayPal rejected the offer: ${err instanceof Error ? err.message : "error"}`);
  }
  let paypalStatus: string | undefined;
  try {
    paypalStatus = await refresh(db, api, disputeId);
  } catch {
    // refreshed on the next poll
  }
  return { submitted: true, paypalStatus };
}

/** Accepts the buyer's claim (refund). */
export async function submitAccept(
  db: Db,
  disputeId: string,
  body: { sellerConfirmed?: unknown; note?: unknown },
  deps: Deps = {},
): Promise<SubmitResult> {
  if (!confirmed(body)) return refuse("Seller confirmation is required before anything is sent to PayPal.");
  const api = deps.api ?? paypalDisputes;
  const dispute = await loadDispute(db, disputeId);
  if (!dispute) return refuse("Dispute not found.");
  if (isResolved(dispute.status)) return refuse("This dispute is already resolved.");

  if (dispute.simulated) return { submitted: true, simulated: true };
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : DEFAULT_ACCEPT_NOTE;
  try {
    await api.acceptClaim(disputeId, note);
  } catch (err) {
    return refuse(`PayPal rejected the request: ${err instanceof Error ? err.message : "error"}`);
  }
  let paypalStatus: string | undefined;
  try {
    paypalStatus = await refresh(db, api, disputeId);
  } catch {
    // refreshed on the next poll
  }
  return { submitted: true, paypalStatus };
}
