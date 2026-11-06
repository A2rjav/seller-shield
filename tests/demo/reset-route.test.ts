import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { fakePaypal } from "./helpers";
import type { Db } from "@/lib/db/client";

const holder = vi.hoisted(() => ({ entries: [] as { orderId: string; scenario: string }[], db: null as unknown as Db, getOrder: null as unknown as (id: string) => Promise<unknown> }));
vi.mock("@/lib/db/client", () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as unknown as Record<PropertyKey, unknown>;
      const v = real[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  }),
}));
vi.mock("@/lib/paypal/orders", async (orig) => ({ ...(await orig<object>()), getOrder: (id: string) => holder.getOrder(id) }));
vi.mock("@/lib/paypal/tracking", () => ({ addTracking: async () => undefined }));

import { POST } from "@/app/api/demo/reset/route";

vi.mock("@/lib/demo/baseline", () => ({ loadBaseline: () => holder.entries }));

describe("POST /api/demo/reset", () => {
  beforeEach(async () => {
    holder.db = await createTestDb();
    holder.getOrder = fakePaypal().getOrder;
  });

  it("resets once, then answers 429 with the seconds remaining", async () => {
    const a = await POST();
    expect(a.status).toBe(200);
    const b = await POST();
    expect(b.status).toBe(429);
    const body = await b.json();
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(b.headers.get("Retry-After")).toBe(String(body.retryAfterSec));
  });

  it("answers 503 with the warnings, and frees the cooldown, when a sample order cannot be reloaded", async () => {
    holder.entries = [{ orderId: "O-X", scenario: "tracking_not_pushed" }];
    holder.getOrder = async () => {
      throw new Error("PayPal down");
    };
    const a = await POST();
    expect(a.status).toBe(503);
    expect((await a.json()).warnings.join(" ")).toContain("O-X");
    holder.getOrder = fakePaypal().getOrder;
    expect((await POST()).status).toBe(200);
  });
});
