import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { disputes, messages, mandates, orders, shipments } from "@/lib/db/schema";
import { buildEvidenceFolder } from "@/lib/evidence/folder";
import { createTestDb } from "../helpers/testDb";

const addr = { line1: "12 Oak St", city: "Portland", state: "OR", postalCode: "97214", countryCode: "US" };
let db: Db;

async function seedOrder(id: string, source: "human" | "agent" = "human") {
  await db.insert(orders).values({
    id, source, status: "COMPLETED", amountCents: 6000, currency: "USD", buyerEmail: "b@example.com",
    payerId: "PAYER1", shipName: "Bea Buyer", shipAddress: addr, items: [{ sku: "ring-1", name: "Silver ring", qty: 1 }],
    captureId: `CAP-${id}`, mandateId: source === "agent" ? `m-${id}` : null,
    createdAt: new Date("2026-11-05T10:00:00Z"), approvedAt: new Date("2026-11-05T10:01:00Z"),
  });
}
async function seedShipment(orderId: string, simulated = true) {
  await db.insert(shipments).values({
    id: `s-${orderId}`, orderId, carrier: "USPS", trackingNumber: "9400111", pushedToPaypal: true,
    pushedAt: new Date("2026-11-06T09:00:00Z"), status: "delivered", deliveredAt: new Date("2026-11-09T15:00:00Z"),
    simulated, shipToAddress: addr,
  });
}
async function seedMandate(orderId: string, verified: boolean, failures: string[] = []) {
  await db.insert(mandates).values({
    id: `m-${orderId}`, orderId, shopperJws: "a", agentJws: "b", hash: "hash123", verified, failures,
    payerEmailMatch: true,
    payload: {
      mandateId: `m-${orderId}`, shopperEmail: "b@example.com", agentId: "agent-7", merchantId: "juniper-and-thread",
      items: [{ sku: "ring-1", qty: 1 }], maxAmountCents: 7000, currency: "USD",
      createdAt: "2026-11-05T09:00:00.000Z", expiresAt: "2026-11-06T09:00:00.000Z", shopperPublicJwk: {},
    },
  });
}

beforeEach(async () => { db = await createTestDb(); });

describe("buildEvidenceFolder", () => {
  it("agent order folder contains mandate, payer_approval and agent_identity items", async () => {
    await seedOrder("O1", "agent");
    await seedMandate("O1", true);
    const f = await buildEvidenceFolder(db, { orderId: "O1" });
    const kinds = f.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["mandate", "payer_approval", "agent_identity", "order", "capture", "ship_address", "policy_at_checkout"]));
    const m = f.find((i) => i.kind === "mandate")!;
    expect(m.summary).toContain("verified: true");
    expect(m.summary).toContain("$70.00");
    expect(m.source).toBe("mandate");
    expect(f.find((i) => i.kind === "agent_identity")!.summary).toContain("agent-7");
  });

  it("failed mandate is shown as unverified with failures", async () => {
    await seedOrder("O2", "agent");
    await seedMandate("O2", false, ["expired"]);
    const m = (await buildEvidenceFolder(db, { orderId: "O2" })).find((i) => i.kind === "mandate")!;
    expect(m.summary).toContain("verified: false");
    expect(m.summary).toContain("expired");
    expect(m.summary).not.toContain("verified: true");
  });

  it("human order has no mandate items", async () => {
    await seedOrder("O3");
    const kinds = (await buildEvidenceFolder(db, { orderId: "O3" })).map((i) => i.kind);
    expect(kinds).not.toContain("mandate");
    expect(kinds).not.toContain("agent_identity");
  });

  it("simulated delivery item has simulated true and demo_carrier source", async () => {
    await seedOrder("O4");
    await seedShipment("O4", true);
    const f = await buildEvidenceFolder(db, { orderId: "O4" });
    const d = f.find((i) => i.kind === "delivery")!;
    expect(d.simulated).toBe(true);
    expect(d.source).toBe("demo_carrier");
    expect(d.summary).toBe("Delivered 2026-11-09 to Portland, OR 97214 (USPS 9400111)");
    expect(f.find((i) => i.kind === "tracking")!.summary).toContain("pushed to PayPal 2026-11-06");
  });

  it("orderId null -> only paypal-sourced items", async () => {
    await seedOrder("O5");
    await db.insert(disputes).values({
      id: "D1", orderId: null, captureId: "CAP-X", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN",
      stage: "INQUIRY", amountCents: 6000, currency: "USD", raw: { create_time: "2026-11-10T00:00:00Z" },
    });
    await db.insert(messages).values([
      { id: "pm1", disputeId: "D1", author: "buyer", body: "Never arrived", source: "paypal_dispute", createdAt: new Date("2026-11-10T01:00:00Z") },
      { id: "sm1", orderId: "O5", author: "buyer", body: "Hello", source: "storefront" },
    ]);
    const f = await buildEvidenceFolder(db, { orderId: null, disputeId: "D1" });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((i) => i.source === "paypal")).toBe(true);
    expect(f.some((i) => i.kind === "buyer_message" && i.summary.includes("Never arrived"))).toBe(true);
  });

  it("ids are stable and items sorted by at, nulls last", async () => {
    await seedOrder("O6");
    await seedShipment("O6");
    const a = await buildEvidenceFolder(db, { orderId: "O6" });
    const b = await buildEvidenceFolder(db, { orderId: "O6" });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a.find((i) => i.kind === "tracking")!.id).toBe("ev:tracking:s-O6");
    expect(new Set(a.map((i) => i.id)).size).toBe(a.length);
    const ats = a.map((i) => i.at);
    const firstNull = ats.indexOf(null);
    if (firstNull >= 0) expect(ats.slice(firstNull).every((x) => x === null)).toBe(true);
    const real = ats.filter((x): x is string => x !== null);
    expect([...real].sort()).toEqual(real);
  });
});
