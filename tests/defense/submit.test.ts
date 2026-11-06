import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { cases, disputes, orders } from "@/lib/db/schema";
import { buildCase } from "@/lib/defense/build-case";
import { submitAccept, submitCase, submitOffer } from "@/lib/defense/submit";
import { REASON_REQUIREMENTS } from "@/lib/evidence/requirements";
import { templateCase } from "@/lib/defense/case";
import type { EvidenceItem } from "@/lib/evidence/folder";
import type { PaypalDispute } from "@/lib/paypal/disputes";

const gathered: EvidenceItem[] = [
  { id: "ev:dispute:D1", kind: "dispute", title: "Dispute", at: "2026-11-07T00:00:00.000Z", summary: "Dispute D1 opened 2026-11-07 for $60.00", data: {}, source: "paypal", simulated: false },
];

async function setup(simulated: boolean) {
  const db = await createTestDb();
  await db.insert(orders).values({
    id: "O1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD",
    items: [{ sku: "silver-hoops", qty: 1 }], createdAt: new Date("2026-11-05T10:00:00Z"),
  });
  await db.insert(disputes).values({
    id: "D1", orderId: "O1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE",
    stage: "INQUIRY", amountCents: 6000, currency: "USD", simulated, lastEventAt: new Date("2026-11-07T00:00:00Z"),
  });
  const write = vi.fn(async (input: { folder: EvidenceItem[]; requirements: { needed: never[] } }) => ({
    draft: templateCase(input.folder, input.requirements), usedFallback: true,
  }));
  const deps = { gather: vi.fn(async () => gathered), writeCase: write as never };
  return { db, deps, write };
}

const fresh: PaypalDispute = {
  dispute_id: "D1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "UNDER_REVIEW", update_time: "2026-11-08T00:00:00Z",
  dispute_amount: { currency_code: "USD", value: "60.00" }, dispute_life_cycle_stage: "INQUIRY",
};
const paypal = () => ({
  provideEvidence: vi.fn(async () => {}), makeOffer: vi.fn(async () => {}), acceptClaim: vi.fn(async () => {}),
  getDispute: vi.fn(async () => fresh),
});

describe("buildCase", () => {
  it("stores a case with a Uint8Array pdf and a recommendation", async () => {
    const { db, deps } = await setup(false);
    const c = await buildCase(db, "D1", { deps });
    expect(c.id).toBe("case:D1");
    expect(c.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(c.pdfBytes!.slice(0, 4)).toString()).toBe("%PDF");
    expect(c.recommendation).toMatchObject({ action: expect.any(String) });
    const [row] = await db.select().from(cases).where(eq(cases.id, "case:D1"));
    expect(row.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(row.pdfBytes!.length).toBe(c.pdfBytes!.length);
  });

  it("reuses an existing case unless rebuild is true", async () => {
    const { db, deps, write } = await setup(false);
    await buildCase(db, "D1", { deps });
    await buildCase(db, "D1", { deps });
    expect(write).toHaveBeenCalledTimes(1);
    await buildCase(db, "D1", { deps, rebuild: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect((await db.select().from(cases)).length).toBe(1);
  });

  it("throws for an unknown dispute", async () => {
    const { db, deps } = await setup(false);
    await expect(buildCase(db, "nope", { deps })).rejects.toThrow(/not found/i);
  });
});

describe("submitCase", () => {
  it("submit without sellerConfirmed is refused and makes no PayPal call", async () => {
    const { db, deps } = await setup(false);
    await buildCase(db, "D1", { deps });
    const api = paypal();
    for (const body of [{}, { sellerConfirmed: false }, { sellerConfirmed: "true" }] as never[]) {
      const r = await submitCase(db, "D1", body, { api });
      expect(r.submitted).toBe(false);
      expect(r.error).toMatch(/confirm/i);
    }
    expect(api.provideEvidence).not.toHaveBeenCalled();
    expect(api.getDispute).not.toHaveBeenCalled();
    const [row] = await db.select().from(cases);
    expect(row.submittedAt).toBeNull();
  });

  it("simulated dispute never calls PayPal and returns submitted with simulated flag", async () => {
    const { db, deps } = await setup(true);
    await buildCase(db, "D1", { deps });
    const api = paypal();
    const r = await submitCase(db, "D1", { sellerConfirmed: true }, { api });
    expect(r).toMatchObject({ submitted: true, simulated: true });
    expect(api.provideEvidence).not.toHaveBeenCalled();
    expect(api.getDispute).not.toHaveBeenCalled();
    const [row] = await db.select().from(cases);
    expect(row.submittedAt).toBeInstanceOf(Date);
    expect(row.submitResult).toEqual({ simulated: true });
  });

  it("real dispute calls provideEvidence with evidence type from REASON_REQUIREMENTS, then re-ingests", async () => {
    const { db, deps } = await setup(false);
    await buildCase(db, "D1", { deps });
    const api = paypal();
    const r = await submitCase(db, "D1", { sellerConfirmed: true }, { api });
    expect(r).toMatchObject({ submitted: true, paypalStatus: "UNDER_REVIEW" });
    expect(api.provideEvidence).toHaveBeenCalledTimes(1);
    const [id, arg] = api.provideEvidence.mock.calls[0] as unknown as [string, { evidenceType: string; pdf: Uint8Array; notes: string }];
    expect(id).toBe("D1");
    expect(arg.evidenceType).toBe(REASON_REQUIREMENTS.MERCHANDISE_OR_SERVICE_NOT_RECEIVED.paypalEvidenceType);
    expect(arg.pdf).toBeInstanceOf(Uint8Array);
    expect(arg.notes.length).toBeGreaterThan(0);
    const [d] = await db.select().from(disputes);
    expect(d.status).toBe("UNDER_REVIEW");
    const [row] = await db.select().from(cases);
    expect(row.submittedAt).toBeInstanceOf(Date);
  });

  it("refuses with no case, an invalid draft, or a resolved dispute", async () => {
    const { db, deps } = await setup(false);
    const api = paypal();
    expect((await submitCase(db, "D1", { sellerConfirmed: true }, { api })).error).toMatch(/no case/i);
    await buildCase(db, "D1", { deps });
    await db.update(cases).set({ draft: { summary: "", timeline: [], argument: [{ text: "x", evidenceIds: ["ev:nope"] }], sellerNote: "" } });
    expect((await submitCase(db, "D1", { sellerConfirmed: true }, { api })).error).toMatch(/evidence|valid/i);
    await buildCase(db, "D1", { deps, rebuild: true });
    await db.update(disputes).set({ status: "RESOLVED" });
    expect((await submitCase(db, "D1", { sellerConfirmed: true }, { api })).error).toMatch(/resolved/i);
    expect(api.provideEvidence).not.toHaveBeenCalled();
  });
});

describe("submitOffer / submitAccept", () => {
  it("offer uses recommendation offerCents by default and validates a custom amount", async () => {
    const { db, deps } = await setup(false);
    await buildCase(db, "D1", { deps });
    const api = paypal();
    expect((await submitOffer(db, "D1", {}, { api })).error).toMatch(/confirm/i);
    expect(api.makeOffer).not.toHaveBeenCalled();
    for (const amountCents of [0, -5, 6001, 10.5]) {
      const r = await submitOffer(db, "D1", { sellerConfirmed: true, amountCents }, { api });
      expect(r.submitted).toBe(false);
    }
    expect(api.makeOffer).not.toHaveBeenCalled();
    const ok = await submitOffer(db, "D1", { sellerConfirmed: true }, { api });
    expect(ok.submitted).toBe(true);
    expect(api.makeOffer).toHaveBeenCalledWith("D1", expect.objectContaining({ amountCents: 3000, currency: "USD" }));
    await submitOffer(db, "D1", { sellerConfirmed: true, amountCents: 2000 }, { api });
    expect(api.makeOffer).toHaveBeenLastCalledWith("D1", expect.objectContaining({ amountCents: 2000 }));
  });

  it("accept requires confirmation, and simulated disputes skip PayPal", async () => {
    const { db } = await setup(false);
    const api = paypal();
    expect((await submitAccept(db, "D1", {}, { api })).submitted).toBe(false);
    expect(api.acceptClaim).not.toHaveBeenCalled();
    const r = await submitAccept(db, "D1", { sellerConfirmed: true }, { api });
    expect(r.submitted).toBe(true);
    expect(api.acceptClaim).toHaveBeenCalledWith("D1", expect.any(String));
    const sim = await setup(true);
    const api2 = paypal();
    const s = await submitAccept(sim.db, "D1", { sellerConfirmed: true }, { api: api2 });
    expect(s).toMatchObject({ submitted: true, simulated: true });
    expect(api2.acceptClaim).not.toHaveBeenCalled();
  });
});
