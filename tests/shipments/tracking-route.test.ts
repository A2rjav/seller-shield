import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { orders, shipments } from "@/lib/db/schema";

const holder = vi.hoisted(() => ({ db: null as unknown as Db, addTracking: null as unknown as ReturnType<typeof vi.fn> }));

vi.mock("@/lib/db/client", () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as unknown as Record<PropertyKey, unknown>;
      const v = real[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  }),
}));
vi.mock("@/lib/paypal/tracking", () => ({ addTracking: (...a: unknown[]) => holder.addTracking(...a) }));

import { POST } from "@/app/api/orders/[id]/tracking/route";

const ADDR = { line1: "12 Fern St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };
const call = (id: string, body: unknown) =>
  POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("POST /api/orders/[id]/tracking", () => {
  beforeEach(async () => {
    holder.db = await createTestDb();
    holder.addTracking = vi.fn().mockResolvedValue(undefined);
    await holder.db.insert(orders).values({
      id: "ORDER-1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD", shipAddress: ADDR, items: [], captureId: "CAP-1",
    });
  });

  it("rejects an unsupported carrier and a malformed tracking number without touching PayPal", async () => {
    expect((await call("ORDER-1", { carrier: "ACME_EXPRESS", trackingNumber: "9400111899223" })).status).toBe(400);
    expect((await call("ORDER-1", { carrier: "USPS", trackingNumber: "12" })).status).toBe(400);
    expect((await call("ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223", extra: 1 })).status).toBe(400);
    expect(holder.addTracking).not.toHaveBeenCalled();
    expect(await holder.db.select().from(shipments)).toHaveLength(0);
  });

  it("returns 404 for an unknown order, for add and for push", async () => {
    expect((await call("NOPE", { carrier: "USPS", trackingNumber: "9400111899223" })).status).toBe(404);
    expect((await call("NOPE", { push: true })).status).toBe(404);
  });

  it("a PayPal refusal leaves the shipment unpushed and a corrected number replaces it (no wedge)", async () => {
    holder.addTracking.mockRejectedValueOnce(new Error("UNPROCESSABLE_ENTITY"));
    const bad = await call("ORDER-1", { carrier: "USPS", trackingNumber: "BADNUMBER1" });
    expect(bad.status).toBe(502);
    let rows = await holder.db.select().from(shipments).where(eq(shipments.orderId, "ORDER-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].pushedToPaypal).toBe(false);

    const good = await call("ORDER-1", { carrier: "UPS", trackingNumber: "1Z999AA10000001" });
    expect(good.status).toBe(200);
    rows = await holder.db.select().from(shipments).where(eq(shipments.orderId, "ORDER-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ carrier: "UPS", trackingNumber: "1Z999AA10000001", pushedToPaypal: true, pushSimulated: false });
    expect(holder.addTracking).toHaveBeenLastCalledWith(expect.objectContaining({ carrier: "UPS", trackingNumber: "1Z999AA10000001" }));
  });

  it("refuses to replace tracking that is already on PayPal, and push needs a shipment", async () => {
    expect((await call("ORDER-1", { push: true })).status).toBe(409);
    expect((await call("ORDER-1", { carrier: "USPS", trackingNumber: "9400111899223" })).status).toBe(200);
    const again = await call("ORDER-1", { carrier: "UPS", trackingNumber: "1Z999AA10000001" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("already_pushed");
  });
});
