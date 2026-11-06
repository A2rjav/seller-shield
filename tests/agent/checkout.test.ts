import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/testDb";
import { mandates } from "@/lib/db/schema";
import { agentCheckout } from "@/lib/agent/checkout";
import { keyPair, NOW, signed } from "./helpers";

let shopper: Awaited<ReturnType<typeof keyPair>>;
let agent: Awaited<ReturnType<typeof keyPair>>;
beforeAll(async () => {
  shopper = await keyPair();
  agent = await keyPair();
});

const items = [{ sku: "silver-hoops", qty: 1 }];
const deps = (createOrder = vi.fn().mockResolvedValue({ id: "PP-1", approveUrl: "https://paypal.test/approve/PP-1" })) => ({
  createOrder,
  agentPublicJwk: agent.pub as JsonWebKey,
  now: () => NOW,
  baseUrl: "http://localhost:3000",
});

describe("agentCheckout", () => {
  it("rejects a tampered mandate with 422 and failures", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const [h, p, sig] = s.shopperJws.split(".");
    const tampered = `${h}.${p.slice(0, -2)}AA.${sig}`;
    const d = deps();
    const r = await agentCheckout(db, { shopperJws: tampered, agentJws: s.agentJws, items }, d);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ failures: expect.arrayContaining(["bad_shopper_signature"]) });
    expect(d.createOrder).not.toHaveBeenCalled();
    expect(await db.select().from(mandates)).toHaveLength(0);
  });

  it("rejects an amount over the mandate maximum", async () => {
    const db = await createTestDb();
    const over = { items: [{ sku: "silver-hoops", qty: 2 }], amountCents: 12000, currency: "USD" };
    const s = await signed(shopper, agent, { items: [{ sku: "silver-hoops", qty: 2 }] }, over);
    const d = deps();
    const r = await agentCheckout(db, { shopperJws: s.shopperJws, agentJws: s.agentJws, items: over.items }, d);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ failures: ["amount_over_max"] });
    expect(d.createOrder).not.toHaveBeenCalled();
  });

  it("creates an order whose custom_id is the mandate hash and stores the mandate row", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const d = deps();
    const r = await agentCheckout(db, { shopperJws: s.shopperJws, agentJws: s.agentJws, items }, d);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ orderId: "PP-1", approveUrl: "https://paypal.test/approve/PP-1", hash: s.hash });
    expect(d.createOrder).toHaveBeenCalledWith(expect.objectContaining({ items, customId: s.hash }));
    const [row] = await db.select().from(mandates).where(eq(mandates.id, "m-1"));
    expect(row).toMatchObject({ orderId: "PP-1", hash: s.hash, verified: true, failures: [] });
  });

  it("refuses a replayed mandate with 409", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const d = deps();
    const input = { shopperJws: s.shopperJws, agentJws: s.agentJws, items };
    expect((await agentCheckout(db, input, d)).status).toBe(200);
    const again = await agentCheckout(db, input, d);
    expect(again.status).toBe(409);
    expect(again.data).toMatchObject({ error: "mandate already used" });
    expect(d.createOrder).toHaveBeenCalledTimes(1);
  });

  it("creates only one PayPal order for two concurrent checkouts with the same mandate", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const createOrder = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { id: "PP-C", approveUrl: "https://paypal.test/approve/PP-C" };
    });
    const input = { shopperJws: s.shopperJws, agentJws: s.agentJws, items };
    const rs = await Promise.all([agentCheckout(db, input, deps(createOrder)), agentCheckout(db, input, deps(createOrder))]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when createOrder fails so a retry succeeds", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const input = { shopperJws: s.shopperJws, agentJws: s.agentJws, items };
    const failing = vi.fn().mockRejectedValue(new Error("paypal down"));
    const r1 = await agentCheckout(db, input, deps(failing));
    expect(r1.status).toBe(502);
    expect(await db.select().from(mandates)).toHaveLength(0);
    const r2 = await agentCheckout(db, input, deps());
    expect(r2.status).toBe(200);
  });

  it("rejects an unknown sku as invalid_order without calling PayPal", async () => {
    const db = await createTestDb();
    const s = await signed(shopper, agent);
    const d = deps();
    const r = await agentCheckout(db, { shopperJws: s.shopperJws, agentJws: s.agentJws, items: [{ sku: "nope", qty: 1 }] }, d);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ failures: ["invalid_order"] });
    expect(d.createOrder).not.toHaveBeenCalled();
  });
});
