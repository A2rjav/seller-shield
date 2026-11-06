import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { orders } from "@/lib/db/schema";

describe("schema", () => {
  it("creates tables via migrations and round-trips an order", async () => {
    const db = await createTestDb();
    await db.insert(orders).values({
      id: "ORDER-1",
      source: "human",
      status: "COMPLETED",
      amountCents: 6000,
      currency: "USD",
      items: [{ sku: "silver-hoops", qty: 1 }],
    });
    const [row] = await db.select().from(orders).where(eq(orders.id, "ORDER-1"));
    expect(row.amountCents).toBe(6000);
    expect(row.items).toEqual([{ sku: "silver-hoops", qty: 1 }]);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
