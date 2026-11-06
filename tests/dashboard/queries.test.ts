import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { cases, disputes, mandates, orders } from "@/lib/db/schema";
import { countOpenDisputes, listDisputeRows, listOrderRows } from "@/lib/dashboard/queries";
import { recomputeProtection } from "@/lib/protection/refresh";
import { addShipment } from "@/lib/shipments/service";

const ADDR = { line1: "1 A St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };

describe("dashboard queries", () => {
  it("builds grid rows with protection, mandate state, coverage and dispute", async () => {
    const db = await createTestDb();
    await db.insert(orders).values([
      { id: "H-1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD", shipName: "Ann", shipAddress: ADDR, items: [], captureId: "C1", createdAt: new Date("2026-11-01T00:00:00Z") },
      { id: "A-1", source: "agent", status: "COMPLETED", amountCents: 4800, currency: "USD", buyerEmail: "b@x.test", shipAddress: ADDR, items: [], captureId: "C2", mandateId: "M1", raw: { devFixture: true }, createdAt: new Date("2026-11-02T00:00:00Z") },
    ]);
    await db.insert(mandates).values({ id: "M1", orderId: "A-1", payload: {}, shopperJws: "x", agentJws: "y", hash: "h", verified: false });
    await addShipment(db, "H-1", { carrier: "USPS", trackingNumber: "9400111899223" });
    await recomputeProtection(db, "H-1");
    await recomputeProtection(db, "A-1");
    await db.insert(disputes).values({ id: "D1", orderId: "H-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", amountCents: 6000, currency: "USD", simulated: true });

    const rows = await listOrderRows(db);
    expect(rows.map((r) => r.id)).toEqual(["A-1", "H-1"]); // newest first
    const [a, h] = rows;
    expect(a).toMatchObject({ source: "agent", mandate: "failed", status: "at_risk", buyer: "b@x.test", devFixture: true, hasShipment: false });
    expect(a.gaps[0].severity).toBe("high"); // high-severity gaps first
    expect(h).toMatchObject({ mandate: null, status: "pending", fix: "push_tracking", hasShipment: true, dispute: { id: "D1", simulated: true } });
    expect(h.firstGapText).toBeTruthy();
    expect(h.coverage.score).toBe(0.75);

    await db.insert(cases).values({ id: "case:D1", disputeId: "D1", draft: { summary: "", timeline: [], argument: [], sellerNote: "" }, recommendation: { action: "fight" } });
    const ds = await listDisputeRows(db);
    expect(ds[0]).toMatchObject({ id: "D1", reasonLabel: "Item not received", recommendation: "fight", caseState: "built", simulated: true });
    expect(await countOpenDisputes(db)).toBe(1);
  });

  it("returns empty lists for an empty shop", async () => {
    const db = await createTestDb();
    expect(await listOrderRows(db)).toEqual([]);
    expect(await listDisputeRows(db)).toEqual([]);
  });
});
