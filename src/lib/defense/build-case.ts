import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { cases, disputes, orders } from "@/lib/db/schema";
import { getProduct } from "@/lib/catalog";
import { toPaypalAmount } from "@/lib/money";
import { buildEvidenceFolder, type EvidenceItem } from "@/lib/evidence/folder";
import { coverage, REASON_REQUIREMENTS, type PaypalReason } from "@/lib/evidence/requirements";
import { DISPUTE_FEE_CENTS, recommend, type Recommendation } from "./recommend";
import { writeCase as defaultWriteCase, type CaseDraft } from "./case";
import { renderEvidencePdf } from "./pdf";
import { gatherWithToolkit } from "./toolkit-gather";

export type CaseRow = typeof cases.$inferSelect;

/** Stored in `cases.recommendation`: the recommendation plus the evidence the case was built from. */
export type StoredRecommendation = Recommendation & {
  coverage: { have: string[]; missing: string[]; score: number };
  evidence: EvidenceItem[];
};

export type BuildDeps = {
  gather?: (disputeId: string, ctx: { orderId?: string }) => Promise<EvidenceItem[]>;
  writeCase?: typeof defaultWriteCase;
};

export const caseId = (disputeId: string) => `case:${disputeId}`;

export function resolveReason(reason: string): PaypalReason {
  return reason in REASON_REQUIREMENTS ? (reason as PaypalReason) : "OTHER";
}

/** Merge by id; the first list (our folder) wins on collision. Sorted by `at`, nulls last. */
export function mergeEvidence(folder: EvidenceItem[], gathered: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set(folder.map((i) => i.id));
  const merged = [...folder, ...gathered.filter((i) => !seen.has(i.id))];
  return merged.sort((a, b) => {
    if (a.at === b.at) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at < b.at ? -1 : 1;
  });
}

function itemCostCents(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const i of items as { sku?: unknown; qty?: unknown }[]) {
    const p = typeof i?.sku === "string" ? getProduct(i.sku) : undefined;
    const qty = typeof i?.qty === "number" && Number.isFinite(i.qty) && i.qty > 0 ? i.qty : 1;
    if (p) total += p.costCents * qty;
  }
  return total;
}

const defaultGather = (disputeId: string, ctx: { orderId?: string }) => gatherWithToolkit(disputeId, { orderId: ctx.orderId });

/** Builds (or reuses) the case for a dispute. One case per dispute: `case:<disputeId>`; `rebuild` overwrites. */
export async function buildCase(
  db: Db,
  disputeId: string,
  opts: { rebuild?: boolean; deps?: BuildDeps } = {},
): Promise<CaseRow> {
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  if (!dispute) throw new Error(`Dispute ${disputeId} not found`);

  const id = caseId(disputeId);
  if (!opts.rebuild) {
    const [existing] = await db.select().from(cases).where(eq(cases.id, id));
    if (existing) return existing;
  }

  const gather = opts.deps?.gather ?? defaultGather;
  const write = opts.deps?.writeCase ?? defaultWriteCase;

  const orderId = dispute.orderId ?? null;
  const folder = await buildEvidenceFolder(db, { orderId, disputeId });
  let gathered: EvidenceItem[] = [];
  try {
    gathered = await gather(disputeId, { orderId: orderId ?? undefined });
  } catch {
    // PayPal unreachable: continue with what we hold locally
  }
  const evidence = mergeEvidence(folder, gathered);

  const reason = resolveReason(dispute.reason);
  const requirements = REASON_REQUIREMENTS[reason];
  const cov = coverage(evidence, reason);
  const [order] = orderId ? await db.select().from(orders).where(eq(orders.id, orderId)) : [];
  const rec = recommend({
    amountCents: dispute.amountCents,
    itemCostCents: itemCostCents(order?.items),
    disputeFeeCents: DISPUTE_FEE_CENTS,
    coverageScore: cov.score,
  });

  const disputeLike = {
    dispute_id: dispute.id,
    reason: dispute.reason,
    dispute_amount: { currency_code: dispute.currency, value: toPaypalAmount(dispute.amountCents) },
  };
  const { draft, usedFallback } = await write({ dispute: disputeLike, folder: evidence, requirements });
  const pdfBytes = await renderEvidencePdf({ dispute: disputeLike, draft, folder: evidence });

  const values = {
    disputeId,
    recommendation: { ...rec, coverage: cov, evidence } satisfies StoredRecommendation,
    draft: draft satisfies CaseDraft,
    pdfBytes,
    submittedAt: null,
    submitResult: null,
    usedFallback,
  };
  const [row] = await db
    .insert(cases)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: cases.id, set: values })
    .returning();
  return row;
}
