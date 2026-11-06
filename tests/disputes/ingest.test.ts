import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { disputes, messages, orders, webhookEvents } from "@/lib/db/schema";
import { handleWebhookEvent, ingestDispute, pollDisputes } from "@/lib/disputes/ingest";
import type { PaypalDispute } from "@/lib/paypal/disputes";
import { createTestDb } from "../helpers/testDb";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

function dispute(over: Partial<PaypalDispute> = {}): PaypalDispute {
  return {
    dispute_id: "PP-D-1",
    create_time: "2026-11-01T10:00:00Z",
    update_time: "2026-11-01T10:00:00Z",
    disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { currency_code: "USD", value: "60.00" },
    dispute_life_cycle_stage: "INQUIRY",
    seller_response_due_date: "2026-11-10T10:00:00Z",
    ...over,
  };
}

async function addOrder(captureId: string | null) {
  await db.insert(orders).values({ id: "ORD-1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD", items: [], captureId });
}

describe("ingestDispute", () => {
  it("links to the order by captureId", async () => {
    await addOrder("CAP-1");
    const r = await ingestDispute(db, dispute(), { eventTime: new Date("2026-11-01T10:00:00Z") });
    expect(r).toEqual({ created: true, changed: true });
    const [row] = await db.select().from(disputes);
    expect(row).toMatchObject({ id: "PP-D-1", orderId: "ORD-1", captureId: "CAP-1", amountCents: 6000, currency: "USD", stage: "INQUIRY", simulated: false });
  });

  it("stores orderId null for an unknown capture id", async () => {
    await addOrder("OTHER");
    await ingestDispute(db, dispute(), { eventTime: new Date("2026-11-01T10:00:00Z") });
    const [row] = await db.select().from(disputes);
    expect(row.orderId).toBeNull();
    expect(row.captureId).toBe("CAP-1");
  });

  it("an UPDATED event older than stored lastEventAt does not overwrite status", async () => {
    await ingestDispute(db, dispute({ status: "RESOLVED" }), { eventTime: new Date("2026-11-02T00:00:00Z") });
    const r = await ingestDispute(db, dispute({ status: "OPEN" }), { eventTime: new Date("2026-11-01T00:00:00Z") });
    expect(r).toEqual({ created: false, changed: false });
    const [row] = await db.select().from(disputes);
    expect(row.status).toBe("RESOLVED");
    expect(row.lastEventAt?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("a newer update overwrites, and keeps the simulated flag", async () => {
    await ingestDispute(db, dispute(), { eventTime: new Date("2026-11-01T00:00:00Z"), simulated: true });
    const r = await ingestDispute(db, dispute({ status: "RESOLVED", dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } }), { eventTime: new Date("2026-11-03T00:00:00Z") });
    expect(r).toEqual({ created: false, changed: true });
    const [row] = await db.select().from(disputes);
    expect(row).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", simulated: true });
  });

  it("copies messages once, mapping ARBITER to paypal, even when re-ingested", async () => {
    await addOrder("CAP-1");
    const d = dispute({
      messages: [
        { posted_by: "BUYER", time_posted: "2026-11-01T11:00:00Z", content: "Where is it?" },
        { posted_by: "ARBITER", time_posted: "2026-11-01T12:00:00Z", content: "Please respond" },
      ],
    });
    await ingestDispute(db, d, { eventTime: new Date("2026-11-01T12:00:00Z") });
    await ingestDispute(db, d, { eventTime: new Date("2026-11-01T13:00:00Z") });
    const rows = await db.select().from(messages).where(eq(messages.disputeId, "PP-D-1"));
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.author).sort()).toEqual(["buyer", "paypal"]);
    expect(rows.every((m) => m.source === "paypal_dispute" && m.orderId === "ORD-1")).toBe(true);
  });
});

describe("handleWebhookEvent", () => {
  const evt = (over: Record<string, unknown> = {}) => ({
    id: "WH-1",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    create_time: "2026-11-01T10:00:05Z",
    resource: dispute(),
    ...over,
  });

  it("the same event id twice is processed then duplicate", async () => {
    expect(await handleWebhookEvent(db, evt())).toBe("processed");
    expect(await handleWebhookEvent(db, evt())).toBe("duplicate");
    expect(await db.select().from(disputes)).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("uses resource update_time as the event time", async () => {
    await handleWebhookEvent(db, evt());
    const [row] = await db.select().from(disputes);
    expect(row.lastEventAt?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("records capture/order events without ingesting", async () => {
    expect(await handleWebhookEvent(db, evt({ id: "WH-2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }))).toBe("processed");
    expect(await handleWebhookEvent(db, evt({ id: "WH-3", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} }))).toBe("processed");
    expect(await db.select().from(disputes)).toHaveLength(0);
  });

  it("ignores unknown event types", async () => {
    expect(await handleWebhookEvent(db, evt({ id: "WH-4", event_type: "BILLING.PLAN.CREATED" }))).toBe("ignored");
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("an ingest failure rolls back the event row, and the retry is processed", async () => {
    await expect(handleWebhookEvent(db, evt({ resource: { dispute_id: "X" } }))).rejects.toThrow();
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(disputes)).toHaveLength(0);
    expect(await handleWebhookEvent(db, evt())).toBe("processed");
    expect(await handleWebhookEvent(db, evt())).toBe("duplicate");
  });

  it("a partially applied ingest is rolled back with the event row", async () => {
    // Valid dispute whose message has an invalid time: the dispute upsert runs first, then the message insert throws.
    const bad = dispute({ messages: [{ posted_by: "BUYER", time_posted: "not a date", content: "x" }] });
    await expect(handleWebhookEvent(db, evt({ resource: bad }))).rejects.toThrow();
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(disputes)).toHaveLength(0);
  });
});

describe("pollDisputes", () => {
  it("fetches full disputes only when new or newer than stored", async () => {
    const full = dispute();
    const summary = (id: string, t: string) => ({ dispute_id: id, update_time: t }) as PaypalDispute;
    const api = {
      listDisputes: vi.fn(async () => [summary("PP-D-1", "2026-11-01T10:00:00Z"), summary("PP-D-2", "2026-11-01T10:00:00Z")]),
      getDispute: vi.fn(async (id: string) => ({ ...full, dispute_id: id })),
    };
    expect(await pollDisputes(db, api)).toEqual({ checked: 2, created: 2, changed: 2 });
    expect(api.getDispute).toHaveBeenCalledTimes(2);
    api.getDispute.mockClear();
    expect(await pollDisputes(db, api)).toEqual({ checked: 2, created: 0, changed: 0 });
    expect(api.getDispute).not.toHaveBeenCalled();
    api.listDisputes.mockResolvedValueOnce([summary("PP-D-1", "2026-11-05T00:00:00Z")]);
    api.getDispute.mockResolvedValueOnce({ ...full, status: "RESOLVED", update_time: "2026-11-05T00:00:00Z" });
    expect(await pollDisputes(db, api)).toEqual({ checked: 1, created: 0, changed: 1 });
  });
});
