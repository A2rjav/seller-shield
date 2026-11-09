// Live check of the AI paths against real Gemini and the configured database:
//   1. buildCase on a dispute (default: the seeded simulated item-not-received dispute) with the real writeCase
//   2. explainGaps on an at-risk order (default: the seeded address_mismatch order)
// Prints per-attempt timings, fallback use and validateClaims results. Uses up to 3 AI calls of the daily cap.
// Run: npx tsx scripts/live-ai-check.ts [disputeId] [atRiskOrderId]
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { askJson, type AskOpts } from "../src/lib/ai/gemini";
import { closeDb, getDb } from "../src/lib/db/client";
import { disputes, orders, protectionChecks, shipments } from "../src/lib/db/schema";
import { buildCase, type StoredRecommendation } from "../src/lib/defense/build-case";
import { validateClaims, writeCase, type CaseDraft } from "../src/lib/defense/case";
import { explainGaps } from "../src/lib/protection/explain";
import type { ProtectionResult } from "../src/lib/protection/rules";
import type { Address } from "../src/lib/paypal/types";

const ms = (t: number) => `${Date.now() - t} ms`;

async function main() {
  const db = getDb();
  const disputeId =
    process.argv[2] ??
    (await db.select({ id: disputes.id }).from(disputes).where(and(eq(disputes.simulated, true), eq(disputes.reason, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"))))[0]?.id;
  if (!disputeId) throw new Error("No simulated item-not-received dispute found: run npm run seed first.");

  // 1. Case build: the real buildCase + writeCase + Gemini, with each model attempt timed.
  let attempt = 0;
  const timedAsk = async <T,>(opts: AskOpts<T>) => {
    const t = Date.now();
    const r = await askJson(opts);
    attempt++;
    console.log(`  writeCase attempt ${attempt}: ${r.ok ? "ok" : `failed (${r.reason}${"rateLimited" in r && r.rateLimited ? ", rate limited" : ""})`} in ${ms(t)}`);
    return r;
  };
  const t0 = Date.now();
  const row = await buildCase(db, disputeId, { rebuild: true, deps: { writeCase: (input) => writeCase(input, { askJson: timedAsk }) } });
  const rec = row.recommendation as StoredRecommendation;
  const draft = row.draft as CaseDraft;
  const v = validateClaims(draft, rec.evidence);
  console.log(
    JSON.stringify(
      {
        step: "buildCase",
        disputeId,
        totalMs: Date.now() - t0,
        modelAttempts: attempt,
        usedFallback: row.usedFallback,
        validateClaims: v.ok ? "pass" : v.problems,
        recommendation: rec.action,
        coverage: rec.coverage.score,
        evidenceItems: rec.evidence.length,
        timeline: draft.timeline.length,
        argument: draft.argument.length,
        pdfBytes: row.pdfBytes?.length ?? 0,
      },
      null,
      1,
    ),
  );
  console.log("  first argument entry:", draft.argument[0]?.text.slice(0, 240));

  // 2. Gap explanation for an at-risk order.
  const pc = await db.select().from(protectionChecks);
  const target = process.argv[3] ?? pc.find((p) => (p.result as ProtectionResult).status === "at_risk")?.orderId;
  if (!target) {
    console.log("No at-risk order found; skipped explainGaps.");
    return;
  }
  const [o] = await db.select().from(orders).where(eq(orders.id, target));
  const [s] = await db.select().from(shipments).where(eq(shipments.orderId, target));
  const result = pc.find((p) => p.orderId === target)!.result as ProtectionResult;
  const t1 = Date.now();
  const ex = await explainGaps(result, {
    amountCents: o.amountCents,
    currency: o.currency,
    paypalShipAddress: (o.shipAddress as Address | null) ?? null,
    shipToAddress: (s?.shipToAddress as Address | null) ?? null,
  });
  console.log(JSON.stringify({ step: "explainGaps", orderId: target, ms: Date.now() - t1, gaps: result.gaps.map((g) => g.code), ...ex }, null, 1));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
