import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { demoState, disputes, messages, orders } from "@/lib/db/schema";
import { PaypalError } from "@/lib/paypal/client";
import type { PaypalDispute } from "@/lib/paypal/disputes";

const holder = vi.hoisted(() => ({
  db: null as unknown as Db,
  getDispute: null as unknown as (id: string) => Promise<unknown>,
  calls: [] as string[],
}));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as unknown as Record<PropertyKey, unknown>;
      const v = real[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  }),
}));
vi.mock("@/lib/paypal/disputes", async (orig) => ({
  ...(await orig<object>()),
  getDispute: (id: string) => {
    holder.calls.push(id);
    return holder.getDispute(id);
  },
}));

import { POST } from "@/app/api/demo/fetch-dispute/route";

const post = (body: unknown) => POST(new Request("http://x/api/demo/fetch-dispute", { method: "POST", body: JSON.stringify(body) }));

/** Shaped like the real sandbox INR dispute from the 2026-11-09 spike (trimmed). */
function sandboxDispute(id: string, over: Partial<PaypalDispute> = {}): PaypalDispute {
  return {
    dispute_id: id,
    create_time: "2026-11-09T12:35:48.000Z",
    update_time: "2026-11-09T12:36:10.000Z",
    disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { currency_code: "USD", value: "25.00" },
    dispute_life_cycle_stage: "INQUIRY",
    seller_response_due_date: "2026-11-29T12:35:48.000Z",
    messages: [{ posted_by: "BUYER", time_posted: "2026-11-09T12:35:48.000Z", content: "Still waiting for my cuff." }],
    ...over,
  };
}

describe("POST /api/demo/fetch-dispute", () => {
  beforeEach(async () => {
    holder.db = await createTestDb();
    holder.calls = [];
    holder.getDispute = async (id) => sandboxDispute(id);
    await holder.db.insert(orders).values({ id: "O-1", source: "human", status: "COMPLETED", amountCents: 2500, currency: "USD", items: [], captureId: "CAP-1" });
  });

  it("fetches a PP-R inquiry by id, stores it as a real dispute and links it to the order by capture id", async () => {
    const res = await post({ disputeId: " pp-r-oqi-10197477 " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(holder.calls).toEqual(["PP-R-OQI-10197477"]);
    expect(body).toMatchObject({ created: true, dispute: { id: "PP-R-OQI-10197477", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", orderId: "O-1" } });
    const [d] = await holder.db.select().from(disputes).where(eq(disputes.id, "PP-R-OQI-10197477"));
    expect(d).toMatchObject({ simulated: false, orderId: "O-1", amountCents: 2500 });
    expect(await holder.db.select().from(messages).where(eq(messages.disputeId, "PP-R-OQI-10197477"))).toHaveLength(1);
  });

  it("accepts PP-D ids and refreshes an already stored dispute without duplicating it", async () => {
    expect((await post({ disputeId: "PP-D-12345" })).status).toBe(200);
    await holder.db.delete(demoState); // lift the throttle: this test is about refreshing, not rate limiting
    holder.getDispute = async (id) => sandboxDispute(id, { status: "UNDER_REVIEW", update_time: "2026-11-09T13:00:00.000Z" });
    const body = await (await post({ disputeId: "PP-D-12345" })).json();
    expect(body).toMatchObject({ created: false, changed: true, dispute: { status: "UNDER_REVIEW" } });
    expect(await holder.db.select().from(disputes)).toHaveLength(1);
  });

  it.each([{}, { disputeId: "" }, { disputeId: "SIM-1234" }, { disputeId: "PP-X-123" }, { disputeId: "PP-R-../../v1" }, { disputeId: "PP-R-1", extra: 1 }])(
    "rejects %j with 400 and never calls PayPal",
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(holder.calls).toEqual([]);
    },
  );

  it("answers 404 when PayPal does not know the id", async () => {
    holder.getDispute = async () => {
      throw new PaypalError({ status: 404, name: "RESOURCE_NOT_FOUND" });
    };
    const res = await post({ disputeId: "PP-R-NOPE-1" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no dispute/i);
    expect(await holder.db.select().from(disputes)).toHaveLength(0);
  });

  it("answers 500 with a generic message when PayPal fails otherwise", async () => {
    holder.getDispute = async () => {
      throw new PaypalError({ status: 503, name: "SERVICE_UNAVAILABLE", message: "secret-ish upstream detail" });
    };
    const res = await post({ disputeId: "PP-R-ABC-1" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("upstream detail");
  });

  describe("throttle", () => {
    it("answers 429 with Retry-After for the same id within 15 s, without calling PayPal again", async () => {
      expect((await post({ disputeId: "PP-R-ABC-1" })).status).toBe(200);
      const res = await post({ disputeId: "pp-r-abc-1" });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(15);
      expect(holder.calls).toEqual(["PP-R-ABC-1"]);
    });

    it("allows the same id again once 15 s have passed, and other ids meanwhile", async () => {
      await post({ disputeId: "PP-R-ABC-1" });
      expect((await post({ disputeId: "PP-R-ABC-2" })).status).toBe(200);
      await holder.db.update(demoState).set({ updatedAt: sql`now() - interval '16 seconds'` }).where(eq(demoState.key, "fetch:PP-R-ABC-1"));
      expect((await post({ disputeId: "PP-R-ABC-1" })).status).toBe(200);
    });

    it("caps fetches at 10 per minute globally, then recovers when the window expires", async () => {
      for (let i = 1; i <= 10; i++) expect((await post({ disputeId: `PP-R-CAP-${i}` })).status).toBe(200);
      const res = await post({ disputeId: "PP-R-CAP-11" });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(holder.calls).toHaveLength(10);
      // the refused id was not charged its own 15 s
      await holder.db.update(demoState).set({ updatedAt: sql`now() - interval '61 seconds'` }).where(eq(demoState.key, "fetch_window"));
      expect((await post({ disputeId: "PP-R-CAP-11" })).status).toBe(200);
    });

    it("does not grow demo_state: 30 distinct ids beyond the global cap leave at most cap-many fetch rows, and old rows are pruned", async () => {
      for (let i = 1; i <= 40; i++) await post({ disputeId: `PP-R-GROW-${i}` });
      const rows = await holder.db.select().from(demoState);
      expect(rows.filter((r) => r.key.startsWith("fetch:")).length).toBeLessThanOrEqual(10);
      await holder.db.update(demoState).set({ updatedAt: sql`now() - interval '2 hours'` }).where(eq(demoState.key, "fetch:PP-R-GROW-1"));
      await post({ disputeId: "PP-R-GROW-99" });
      expect(await holder.db.select().from(demoState).where(eq(demoState.key, "fetch:PP-R-GROW-1"))).toHaveLength(0);
    });

    it("does not count malformed bodies or throttled repeats against the cap", async () => {
      await post({ disputeId: "bad" });
      for (let i = 0; i < 5; i++) await post({ disputeId: "PP-R-SAME-1" });
      expect(holder.calls).toEqual(["PP-R-SAME-1"]);
      const [w] = await holder.db.select().from(demoState).where(eq(demoState.key, "fetch_window"));
      expect(w.value).toEqual({ n: 1 });
    });
  });
});
