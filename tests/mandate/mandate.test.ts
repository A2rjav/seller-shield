import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  canonicalHash,
  verifyMandate,
  checkPayerMatch,
  signMandate,
  signAgentRequest,
  type MandatePayload,
} from "@/lib/mandate/mandate";

type Jwk = import("jose").JWK;
let shopper: { priv: CryptoKey; pub: Jwk };
let agent: { priv: CryptoKey; pub: Jwk };
let other: { priv: CryptoKey; pub: Jwk };

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { priv: privateKey as CryptoKey, pub: await exportJWK(publicKey) };
}

const NOW = new Date("2026-11-05T12:00:00Z");
const order = { items: [{ sku: "ring-1", qty: 1 }], amountCents: 5000, currency: "USD" };

function payload(): MandatePayload {
  return {
    mandateId: "m-1",
    shopperEmail: "buyer@x.com",
    agentId: "agent-1",
    merchantId: "juniper-and-thread",
    items: [{ sku: "ring-1", qty: 2 }, { sku: "ear-1", qty: 1 }],
    maxAmountCents: 6000,
    currency: "USD",
    createdAt: "2026-11-05T00:00:00Z",
    expiresAt: "2026-11-06T00:00:00Z",
    shopperPublicJwk: shopper.pub,
  };
}

async function build(opts: { p?: MandatePayload; o?: typeof order; kid?: string; agentKey?: CryptoKey } = {}) {
  const p = opts.p ?? payload();
  const o = opts.o ?? order;
  const shopperJws = await signMandate(p, shopper.priv);
  const agentJws = await signAgentRequest(
    { mandateHash: canonicalHash(p), orderRequest: o },
    opts.agentKey ?? agent.priv,
    opts.kid ?? p.agentId,
  );
  return { shopperJws, agentJws, agentPublicJwk: agent.pub, order: o, now: NOW };
}

beforeAll(async () => {
  shopper = await keys();
  agent = await keys();
  other = await keys();
});

describe("mandate", () => {
  it("verifies a valid mandate and returns hash", async () => {
    const r = await verifyMandate(await build());
    expect(r.failures).toEqual([]);
    expect(r.verified).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.hash).toBe(canonicalHash(payload()));
    expect(r.payload?.mandateId).toBe("m-1");
  });

  it("same payload with keys in different order -> same hash", () => {
    const p = payload();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as MandatePayload;
    expect(canonicalHash(reordered)).toBe(canonicalHash(p));
    expect(canonicalHash({ ...p, maxAmountCents: 1 })).not.toBe(canonicalHash(p));
  });

  it("bad_shopper_signature on tampered payload", async () => {
    const input = await build();
    const [h, pl, s] = input.shopperJws.split(".");
    const json = JSON.parse(Buffer.from(pl, "base64url").toString());
    json.maxAmountCents = 999999;
    const forged = Buffer.from(JSON.stringify(json)).toString("base64url");
    const r = await verifyMandate({ ...input, shopperJws: `${h}.${forged}.${s}` });
    expect(r.verified).toBe(false);
    expect(r.failures).toEqual(["bad_shopper_signature"]);
    expect(r.payload).toBeUndefined();
  });

  it("bad_shopper_signature when signed by a key other than the embedded one", async () => {
    const shopperJws = await signMandate(payload(), other.priv);
    const input = await build();
    const r = await verifyMandate({ ...input, shopperJws });
    expect(r.failures).toEqual(["bad_shopper_signature"]);
  });

  it("bad_shopper_signature on garbage input", async () => {
    const r = await verifyMandate({ ...(await build()), shopperJws: "nope" });
    expect(r.failures).toEqual(["bad_shopper_signature"]);
  });

  it("bad_agent_signature with wrong agent key", async () => {
    const r = await verifyMandate({ ...(await build({ agentKey: other.priv })) });
    expect(r.verified).toBe(false);
    expect(r.failures).toContain("bad_agent_signature");
    expect(r.hash).toBeDefined();
  });

  it("bad_agent_signature when agent signed a different order", async () => {
    const input = await build({ o: { ...order, amountCents: 100 } });
    const r = await verifyMandate({ ...input, order });
    expect(r.failures).toContain("bad_agent_signature");
  });

  it("bad_agent_signature when agent signed a different mandate hash", async () => {
    const input = await build();
    const agentJws = await signAgentRequest({ mandateHash: "0".repeat(64), orderRequest: order }, agent.priv, "agent-1");
    const r = await verifyMandate({ ...input, agentJws });
    expect(r.failures).toContain("bad_agent_signature");
  });

  it("expired", async () => {
    const r = await verifyMandate({ ...(await build()), now: new Date("2026-11-06T00:00:01Z") });
    expect(r.failures).toEqual(["expired"]);
  });

  it("amount_over_max", async () => {
    const o = { ...order, amountCents: 6100 };
    const r = await verifyMandate(await build({ o }));
    expect(r.failures).toEqual(["amount_over_max"]);
  });

  it("item_not_in_mandate for unknown sku", async () => {
    const o = { ...order, items: [{ sku: "necklace-9", qty: 1 }] };
    const r = await verifyMandate(await build({ o }));
    expect(r.failures).toEqual(["item_not_in_mandate"]);
  });

  it("item_not_in_mandate when qty exceeds mandate", async () => {
    const o = { ...order, items: [{ sku: "ring-1", qty: 3 }] };
    const r = await verifyMandate(await build({ o }));
    expect(r.failures).toEqual(["item_not_in_mandate"]);
  });

  it("currency_mismatch", async () => {
    const o = { ...order, currency: "EUR" };
    const r = await verifyMandate(await build({ o }));
    expect(r.failures).toEqual(["currency_mismatch"]);
  });

  it("agent_not_named when kid != agentId", async () => {
    const r = await verifyMandate(await build({ kid: "agent-2" }));
    expect(r.failures).toEqual(["agent_not_named"]);
  });

  it("collects multiple failures", async () => {
    const o = { items: [{ sku: "x", qty: 1 }], amountCents: 9999, currency: "EUR" };
    const r = await verifyMandate({ ...(await build({ o })), now: new Date("2027-01-01T00:00:00Z") });
    expect(r.failures.sort()).toEqual(["amount_over_max", "currency_mismatch", "expired", "item_not_in_mandate"]);
  });

  const signRaw = async (obj: unknown) => {
    const input = await build();
    return { input, jws: await signMandate(obj as MandatePayload, shopper.priv) };
  };

  it.each([
    ["missing maxAmountCents", (p: any) => { delete p.maxAmountCents; }],
    ["string maxAmountCents", (p: any) => { p.maxAmountCents = "6000"; }],
    ["missing agentId", (p: any) => { delete p.agentId; }],
    ["missing items", (p: any) => { delete p.items; }],
    ["non-array items", (p: any) => { p.items = "ring"; }],
    ["empty items", (p: any) => { p.items = []; }],
    ["fractional mandate qty", (p: any) => { p.items = [{ sku: "ring-1", qty: 1.5 }]; }],
    ["bad merchantId", (p: any) => { p.merchantId = "other"; }],
    ["bad currency", (p: any) => { p.currency = "EUR"; }],
    ["bad expiresAt", (p: any) => { p.expiresAt = "tomorrow"; }],
  ])("malformed_mandate: %s (signed but ill-shaped)", async (_n, mutate) => {
    const p: any = payload();
    mutate(p);
    const { input, jws } = await signRaw(p);
    const r = await verifyMandate({ ...input, shopperJws: jws });
    expect(r.verified).toBe(false);
    expect(r.failures).toEqual(["malformed_mandate"]);
    expect(r.payload).toBeUndefined();
    expect(r.hash).toBeUndefined();
  });

  it.each([
    ["negative qty", { items: [{ sku: "ring-1", qty: -1 }], amountCents: 5000, currency: "USD" }],
    ["fractional qty", { items: [{ sku: "ring-1", qty: 0.5 }], amountCents: 5000, currency: "USD" }],
    ["zero qty", { items: [{ sku: "ring-1", qty: 0 }], amountCents: 5000, currency: "USD" }],
    ["NaN amount", { items: order.items, amountCents: NaN, currency: "USD" }],
    ["negative amount", { items: order.items, amountCents: -5, currency: "USD" }],
    ["fractional amount", { items: order.items, amountCents: 50.5, currency: "USD" }],
    ["empty items", { items: [], amountCents: 5000, currency: "USD" }],
    ["missing items", { amountCents: 5000, currency: "USD" }],
    ["empty currency", { items: order.items, amountCents: 5000, currency: "" }],
  ])("invalid_order: %s", async (_n, o) => {
    const input = await build({ o: o as any });
    const r = await verifyMandate({ ...input, order: o as any });
    expect(r.verified).toBe(false);
    expect(r.failures).toContain("invalid_order");
    expect(r.failures).not.toContain("amount_over_max");
  });

  it("rejects an alg:none JWS as bad_shopper_signature", async () => {
    const input = await build();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jws = `${b64({ alg: "none" })}.${b64(payload())}.`;
    const r = await verifyMandate({ ...input, shopperJws: jws });
    expect(r.failures).toEqual(["bad_shopper_signature"]);
  });

  it("rejects an HS256 JWS as bad_shopper_signature", async () => {
    const input = await build();
    const jws = await new SignJWT({ ...payload() }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("k".repeat(32)));
    const r = await verifyMandate({ ...input, shopperJws: jws });
    expect(r.failures).toEqual(["bad_shopper_signature"]);
  });

  it("malformed agentJws yields bad_agent_signature", async () => {
    const r = await verifyMandate({ ...(await build()), agentJws: "garbage" });
    expect(r.failures).toContain("bad_agent_signature");
  });

  it("malformed shopperPublicJwk yields bad_shopper_signature", async () => {
    const p = { ...payload(), shopperPublicJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } } as MandatePayload;
    const { input, jws } = await signRaw(p);
    const r = await verifyMandate({ ...input, shopperJws: jws });
    expect(r.failures).toEqual(["bad_shopper_signature"]);
  });

  it("never throws on garbage input", async () => {
    const r = await verifyMandate({ shopperJws: 5, agentJws: null, agentPublicJwk: null, order: null, now: "x" } as any);
    expect(r.verified).toBe(false);
  });

  it("checkPayerMatch is case-insensitive and trimmed", () => {
    expect(checkPayerMatch(payload(), " Buyer@X.com ")).toBe(true);
    expect(checkPayerMatch(payload(), "other@x.com")).toBe(false);
  });
});
