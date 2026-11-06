import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import type { Db } from "@/lib/db/client";
import { messages, orders } from "@/lib/db/schema";

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

import { POST } from "@/app/api/orders/[id]/messages/route";

const call = (id: string, body: unknown) =>
  POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("POST /api/orders/[id]/messages (M6)", () => {
  beforeEach(async () => {
    holder.db = await createTestDb();
    await holder.db.insert(orders).values({ id: "O1", source: "human", status: "COMPLETED", amountCents: 6000, currency: "USD", items: [] });
  });

  it("stores up to 20 messages per order, then answers 409", async () => {
    for (let i = 0; i < 20; i++) expect((await call("O1", { body: `msg ${i}` })).status).toBe(201);
    const over = await call("O1", { body: "one more" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toMatch(/20/);
    expect(await holder.db.select().from(messages).where(eq(messages.orderId, "O1"))).toHaveLength(20);
  });

  it("still rejects bodies over 2000 characters and unknown orders", async () => {
    expect((await call("O1", { body: "x".repeat(2001) })).status).toBe(400);
    expect((await call("NOPE", { body: "hi" })).status).toBe(404);
  });
});
