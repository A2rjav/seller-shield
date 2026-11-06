import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { disputes, messages, orders } from "@/lib/db/schema";
import { createSimulatedDispute, DemoError, resolveDispute } from "@/lib/demo/simulate";

const holder = vi.hoisted(() => ({ db: null as unknown as Db }));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as unknown as Record<PropertyKey, unknown>;
      const v = real[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  }),
}));
import { POST as disputePOST } from "@/app/api/demo/dispute/route";
import { POST as adjudicatePOST } from "@/app/api/demo/adjudicate/route";

const post = (h: (r: Request) => Promise<Response>, body: unknown) =>
  h(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }));

describe("simulated disputes", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    holder.db = db;
    await db.insert(orders).values({ id: "O-1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD", items: [], captureId: "CAP-1" });
  });

  it("creates a labelled demo dispute with a buyer message, due in 10 days", async () => {
    const now = new Date("2026-11-06T10:00:00Z");
    const d = await createSimulatedDispute(db, "O-1", "UNAUTHORISED", now);
    expect(d).toMatchObject({ simulated: true, status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK", amountCents: 6000, captureId: "CAP-1", orderId: "O-1" });
    expect(d.id).toMatch(/^SIM-/);
    expect(d.sellerResponseDue?.toISOString()).toBe("2026-11-16T10:00:00.000Z");
    const msgs = await db.select().from(messages).where(eq(messages.disputeId, d.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ author: "buyer", source: "paypal_dispute" });
    expect(msgs[0].body).toMatch(/demo/i);
    expect((await createSimulatedDispute(db, "O-1", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED").catch((e) => e)).status).toBe(409);
  });

  it("uses INQUIRY for item-not-received", async () => {
    expect((await createSimulatedDispute(db, "O-1", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).stage).toBe("INQUIRY");
  });

  it("route: validates input, 404 for unknown order, 409 for a second open dispute", async () => {
    expect((await post(disputePOST, { orderId: "O-1", reason: "BOGUS" })).status).toBe(400);
    expect((await post(disputePOST, { reason: "UNAUTHORISED" })).status).toBe(400);
    expect((await post(disputePOST, { orderId: "NOPE", reason: "UNAUTHORISED" })).status).toBe(404);
    const ok = await post(disputePOST, { orderId: "O-1", reason: "UNAUTHORISED" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).simulated).toBe(true);
    expect((await post(disputePOST, { orderId: "O-1", reason: "UNAUTHORISED" })).status).toBe(409);
  });

  it("the database also blocks a racing second open simulated dispute", async () => {
    const results = await Promise.allSettled([
      createSimulatedDispute(db, "O-1", "UNAUTHORISED"),
      createSimulatedDispute(db, "O-1", "UNAUTHORISED"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(DemoError);
    expect((rej.reason as DemoError).status).toBe(409);
  });

  it("resolves a simulated dispute locally without calling PayPal, and allows a new one afterwards", async () => {
    const d = await createSimulatedDispute(db, "O-1", "UNAUTHORISED");
    const adjudicate = vi.fn();
    const deps = { adjudicate, getDispute: vi.fn() };
    const r = await resolveDispute(db, { disputeId: d.id, outcome: "SELLER_FAVOR" }, deps);
    expect(r).toMatchObject({ simulated: true, outcome: "RESOLVED_SELLER_FAVOUR" });
    expect(adjudicate).not.toHaveBeenCalled();
    const [row] = await db.select().from(disputes).where(eq(disputes.id, d.id));
    expect(row).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
    expect((await resolveDispute(db, { disputeId: d.id, outcome: "BUYER_FAVOR" }, deps).catch((e) => e)).status).toBe(409);
    await expect(createSimulatedDispute(db, "O-1", "UNAUTHORISED")).resolves.toBeTruthy();
  });

  it("real dispute: calls sandbox adjudicate only in an allowed state, then re-ingests", async () => {
    await db.insert(disputes).values({ id: "PP-D-1", orderId: "O-1", reason: "UNAUTHORISED", status: "UNDER_REVIEW", stage: "CHARGEBACK", amountCents: 6000, currency: "USD", simulated: false });
    const full = (status: string) => ({
      dispute_id: "PP-D-1",
      reason: "UNAUTHORISED",
      status,
      update_time: new Date(Date.now() + 1000).toISOString(),
      dispute_amount: { currency_code: "USD", value: "60.00" },
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_outcome: status === "RESOLVED" ? { outcome_code: "RESOLVED_SELLER_FAVOUR" } : undefined,
    });
    const getDispute = vi.fn().mockResolvedValueOnce(full("UNDER_REVIEW")).mockResolvedValueOnce(full("RESOLVED"));
    const adjudicate = vi.fn().mockResolvedValue(undefined);
    const r = await resolveDispute(db, { disputeId: "PP-D-1", outcome: "SELLER_FAVOR" }, { adjudicate, getDispute });
    expect(adjudicate).toHaveBeenCalledWith("PP-D-1", "SELLER_FAVOR");
    expect(r.simulated).toBe(false);
    const [row] = await db.select().from(disputes).where(eq(disputes.id, "PP-D-1"));
    expect(row).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", simulated: false });
  });

  it("real dispute: refuses with a reason (409) when PayPal would not allow it", async () => {
    await db.insert(disputes).values({ id: "PP-D-2", orderId: "O-1", reason: "UNAUTHORISED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "CHARGEBACK", amountCents: 6000, currency: "USD", simulated: false });
    const adjudicate = vi.fn();
    const getDispute = vi.fn().mockResolvedValue({
      dispute_id: "PP-D-2",
      reason: "UNAUTHORISED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_amount: { currency_code: "USD", value: "60.00" },
      dispute_life_cycle_stage: "CHARGEBACK",
    });
    const err = await resolveDispute(db, { disputeId: "PP-D-2", outcome: "SELLER_FAVOR" }, { adjudicate, getDispute }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/under review/i);
    expect(adjudicate).not.toHaveBeenCalled();
  });

  it("adjudicate route validates input and 404s an unknown dispute", async () => {
    expect((await post(adjudicatePOST, { disputeId: "X", outcome: "NOPE" })).status).toBe(400);
    expect((await post(adjudicatePOST, { disputeId: "X", outcome: "SELLER_FAVOR" })).status).toBe(404);
  });
});
