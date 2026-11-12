import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { fakePaypal, insertMandate, ppOrder } from "./helpers";
import type { Db } from "@/lib/db/client";
import { cases, disputes, mandates, messages, orders, protectionChecks, shipments } from "@/lib/db/schema";
import { describeError, seedDemo, seedModeError, type BaselineEntry } from "@/lib/demo/seed";
import { readTrackers } from "@/lib/paypal/orders";

const ENTRIES: BaselineEntry[] = [
  { orderId: "O-DELIVERED", scenario: "protected_delivered" },
  { orderId: "O-MISMATCH", scenario: "address_mismatch" },
  { orderId: "O-850", scenario: "awaiting_delivery_850" },
  { orderId: "O-NOPUSH", scenario: "tracking_not_pushed" },
  { orderId: "O-AGENT", scenario: "agent_verified" },
  { orderId: "O-DISPUTE", scenario: "dispute_item_not_received" },
];

async function counts(db: Db) {
  return {
    orders: (await db.select().from(orders)).length,
    shipments: (await db.select().from(shipments)).length,
    messages: (await db.select().from(messages)).length,
    disputes: (await db.select().from(disputes)).length,
    protection: (await db.select().from(protectionChecks)).length,
    mandates: (await db.select().from(mandates)).length,
    cases: (await db.select().from(cases)).length,
  };
}

describe("seedDemo", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await insertMandate(db, "mdt_1", "O-AGENT");
  });

  it("is idempotent - running twice yields the same row counts and no repeated PayPal writes", async () => {
    const pp = fakePaypal({ "O-850": "850.00" });
    const deps = { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES };
    const first = await seedDemo(db, deps);
    const c1 = await counts(db);
    const writes1 = pp.calls.filter((c) => c.startsWith("addTracking")).length;
    const second = await seedDemo(db, deps);
    expect(await counts(db)).toEqual(c1);
    expect(pp.calls.filter((c) => c.startsWith("addTracking")).length).toBe(writes1);
    expect(first.warnings).toEqual([]);
    expect(second.seeded).toBe(6);
    expect(c1.orders).toBe(6);
    expect(c1.disputes).toBe(1);
  });

  it("applies each scenario's local data", async () => {
    const pp = fakePaypal({ "O-850": "850.00" });
    await seedDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: ENTRIES });
    const ship = async (id: string) => (await db.select().from(shipments).where(eq(shipments.orderId, id)))[0];

    const delivered = await ship("O-DELIVERED");
    expect(delivered).toMatchObject({ status: "delivered", pushedToPaypal: true, simulated: true });
    expect(delivered.deliveredAt).toBeTruthy();

    const mismatch = await ship("O-MISMATCH");
    expect((mismatch.shipToAddress as { line1: string }).line1).not.toBe("12 Fern St");
    const [protMismatch] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "O-MISMATCH"));
    expect(JSON.stringify(protMismatch.result)).toContain("address_mismatch");

    expect(await ship("O-850")).toMatchObject({ status: "in_transit", pushedToPaypal: true, deliveredAt: null });
    expect(await ship("O-NOPUSH")).toMatchObject({ pushedToPaypal: false });
    expect(pp.calls).not.toContain("addTracking:O-NOPUSH");

    const [agent] = await db.select().from(orders).where(eq(orders.id, "O-AGENT"));
    expect(agent).toMatchObject({ source: "agent", mandateId: "mdt_1" });

    const [d] = await db.select().from(disputes);
    expect(d).toMatchObject({ orderId: "O-DISPUTE", simulated: true, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" });
    expect(d.id).toMatch(/^SIM-/);
  });

  it("skips an agent_verified order with no mandate, with a warning, and never fabricates one", async () => {
    const pp = fakePaypal();
    const r = await seedDemo(db, { getOrder: pp.getOrder, addTracking: pp.addTracking, entries: [{ orderId: "O-NOMANDATE", scenario: "agent_verified" }] });
    expect(r.warnings.join(" ")).toContain("O-NOMANDATE");
    expect(r.seeded).toBe(0);
    expect(await db.select().from(mandates).where(eq(mandates.orderId, "O-NOMANDATE"))).toHaveLength(0);
  });

  it("warns and continues when PayPal cannot return an order", async () => {
    const pp = fakePaypal();
    const r = await seedDemo(db, {
      getOrder: async (id) => {
        if (id === "O-DELIVERED") throw new Error("404");
        return pp.getOrder(id);
      },
      addTracking: pp.addTracking,
      entries: ENTRIES.slice(0, 2),
    });
    expect(r.warnings.join(" ")).toContain("O-DELIVERED");
    expect(r.seeded).toBe(1);
  });
});

/** A real-shaped PayPal order that already carries tracking (tracker ids are "<captureId>-<number>", no carrier field). */
function withTrackers(id: string, ...trackers: { number: string; status?: string }[]) {
  const o = ppOrder(id);
  (o.purchase_units[0] as Record<string, unknown>).shipping = {
    ...o.purchase_units[0].shipping,
    trackers: trackers.map((t) => ({ id: `CAP-${id}-${t.number}`, status: t.status ?? "SHIPPED", items: [], links: [] })),
  };
  return o;
}

describe("seedDemo with tracking already on PayPal (live sandbox data)", () => {
  it("adopts the existing tracker as the pushed shipment and never adds a second one", async () => {
    const db = await createTestDb();
    const calls: string[] = [];
    const deps = {
      getOrder: async (id: string) => withTrackers(id, { number: "1Z999AA10123456784" }),
      addTracking: async (i: { orderId: string }) => void calls.push(i.orderId),
      entries: [{ orderId: "O-TRK", scenario: "protected_delivered" as const }],
    };
    const r = await seedDemo(db, deps);
    await seedDemo(db, deps);
    expect(r.warnings).toEqual([]);
    expect(calls).toEqual([]);
    const [s] = await db.select().from(shipments).where(eq(shipments.orderId, "O-TRK"));
    expect(s).toMatchObject({ carrier: "UPS", trackingNumber: "1Z999AA10123456784", pushedToPaypal: true, pushSimulated: false, status: "delivered" });
  });

  it("gives a tracking_not_pushed order a fresh unpushed simulated shipment even when PayPal holds a tracker, also after a pushed one", async () => {
    const db = await createTestDb();
    const deps = {
      getOrder: async (id: string) => withTrackers(id, { number: "9400100000000000000000" }),
      addTracking: async () => {},
      entries: [{ orderId: "O-NP", scenario: "tracking_not_pushed" as const }],
    };
    const r = await seedDemo(db, deps);
    expect(r.warnings).toEqual([]);
    const [s] = await db.select().from(shipments).where(eq(shipments.orderId, "O-NP"));
    expect(s).toMatchObject({ simulated: true, pushedToPaypal: false });
    expect(s.trackingNumber).not.toBe("9400100000000000000000");
    // A shipment pushed in the meantime is replaced by a new unpushed one on the next seed.
    await db.update(shipments).set({ pushedToPaypal: true }).where(eq(shipments.orderId, "O-NP"));
    expect((await seedDemo(db, deps)).warnings).toEqual([]);
    const rows = await db.select().from(shipments).where(eq(shipments.orderId, "O-NP"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ simulated: true, pushedToPaypal: false });
    expect(rows[0].id).not.toBe(s.id);
    const [chk] = await db.select().from(protectionChecks).where(eq(protectionChecks.orderId, "O-NP"));
    expect(JSON.stringify(chk)).toContain("tracking_not_on_paypal");
  });
});

describe("readTrackers", () => {
  it("strips the capture id prefix, skips cancelled trackers and infers UPS only from 1Z numbers", () => {
    const o = withTrackers("O1", { number: "1Z999AA10123456784" }, { number: "JT22Y249172J758430" }, { number: "OLD1", status: "CANCELLED" });
    expect(readTrackers(o)).toEqual([
      { trackingNumber: "1Z999AA10123456784", carrier: "UPS" },
      { trackingNumber: "JT22Y249172J758430", carrier: null },
    ]);
    expect(readTrackers(ppOrder("O2"))).toEqual([]);
    expect(readTrackers(null)).toEqual([]);
  });
});

describe("describeError", () => {
  it("surfaces the driver cause behind a drizzle 'Failed query' error", () => {
    const e = new Error("Failed query: select 1\nparams: x", { cause: new Error("connect ETIMEDOUT") });
    expect(describeError(e)).toBe("Failed query: select 1 (cause: connect ETIMEDOUT)");
    expect(describeError(new Error("plain"))).toBe("plain");
  });
});

describe("seedModeError", () => {
  it("refuses the dev-pglite fallback unless --dev is passed", () => {
    expect(seedModeError({ NODE_ENV: "development" }, false)).toMatch(/--dev/);
    expect(seedModeError({ NODE_ENV: "development" }, true)).toBeNull();
    expect(seedModeError({ DATABASE_URL: "postgres://x" }, false)).toBeNull();
  });
});
