import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { mandates, orders, protectionChecks } from "@/lib/db/schema";
import { recordCapturedOrder, type RecordInput } from "@/lib/orders/record";
import type { MandatePayload } from "@/lib/mandate/mandate";

const addr = { line1: "12 Alder St", city: "Portland", state: "OR", postalCode: "97201", countryCode: "US" };

function capture(over: Partial<RecordInput> = {}): RecordInput {
  return {
    orderId: "ORD-1",
    source: "human",
    captureId: "CAP-1",
    payerEmail: "buyer@example.com",
    payerId: "PAYER1",
    shipName: "Bea Buyer",
    shipAddress: addr,
    amountCents: 6000,
    currency: "USD",
    items: [{ sku: "silver-hoops", name: "Silver hoop earrings", qty: 1, priceCents: 6000 }],
    ...over,
  };
}

function mandatePayload(email: string): MandatePayload {
  return {
    mandateId: "m-1",
    shopperEmail: email,
    agentId: "agent-1",
    merchantId: "juniper-and-thread",
    items: [{ sku: "silver-hoops", qty: 1 }],
    maxAmountCents: 6000,
    currency: "USD",
    createdAt: "2026-11-01T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z",
    shopperPublicJwk: {},
  };
}

async function seedMandate(db: Db, email: string) {
  await db.insert(mandates).values({
    id: "m-1",
    orderId: "ORD-1",
    payload: mandatePayload(email),
    shopperJws: "a.b.c",
    agentJws: "a.b.c",
    hash: "h",
    verified: true,
    failures: [],
  });
}

describe("recordCapturedOrder", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("stores order and a protection check", async () => {
    await recordCapturedOrder(db, capture());
    const [o] = await db.select().from(orders).where(eq(orders.id, "ORD-1"));
    expect(o.status).toBe("COMPLETED");
    expect(o.source).toBe("human");
    expect(o.amountCents).toBe(6000);
    expect(o.buyerEmail).toBe("buyer@example.com");
    expect(o.approvedAt).toBeInstanceOf(Date);
    expect(o.items).toEqual([{ sku: "silver-hoops", name: "Silver hoop earrings", qty: 1, priceCents: 6000 }]);
    const [pc] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "ORD-1"));
    expect((pc.result as { status: string }).status).toBe("at_risk"); // not shipped yet
  });

  it("records a PENDING capture honestly", async () => {
    await recordCapturedOrder(db, capture({ status: "PENDING" }));
    const [o] = await db.select().from(orders);
    expect(o.status).toBe("PENDING");
  });

  it("is idempotent on order id", async () => {
    await recordCapturedOrder(db, capture());
    await recordCapturedOrder(db, capture());
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(await db.select().from(protectionChecks)).toHaveLength(1);
  });

  it("agent order links the mandate and stores payerEmailMatch true", async () => {
    await seedMandate(db, "Buyer@Example.com");
    await recordCapturedOrder(db, capture({ source: "agent", mandateId: "m-1" }));
    const [m] = await db.select().from(mandates);
    expect(m.payerEmailMatch).toBe(true);
    expect(m.verified).toBe(true);
    expect(m.orderId).toBe("ORD-1");
    const [o] = await db.select().from(orders);
    expect(o.mandateId).toBe("m-1");
    expect(o.source).toBe("agent");
  });

  it("payer email mismatch marks mandate not verified (no duplicate failures on repeat)", async () => {
    await seedMandate(db, "someone-else@example.com");
    await recordCapturedOrder(db, capture({ source: "agent", mandateId: "m-1" }));
    await recordCapturedOrder(db, capture({ source: "agent", mandateId: "m-1" }));
    const [m] = await db.select().from(mandates);
    expect(m.payerEmailMatch).toBe(false);
    expect(m.verified).toBe(false);
    expect(m.failures).toEqual(["payer_email_mismatch"]);
    const [pc] = await db.select().from(protectionChecks);
    expect((pc.result as { gaps: { code: string }[] }).gaps.map((g) => g.code)).toContain("agent_mandate_missing_or_failed");
  });
});
