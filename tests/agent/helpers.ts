import { generateKeyPair, exportJWK, type JWK } from "jose";
import { canonicalHash, signAgentRequest, signMandate, type MandatePayload, type OrderRequest } from "@/lib/mandate/mandate";

export const NOW = new Date("2026-11-05T12:00:00Z");
export const AGENT_ID = "shopper-agent-demo-1";

export async function keyPair() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { priv: privateKey as CryptoKey, pub: (await exportJWK(publicKey)) as JWK };
}

export function mandatePayload(shopperPub: JWK, over: Partial<MandatePayload> = {}): MandatePayload {
  return {
    mandateId: "m-1",
    shopperEmail: "buyer@example.com",
    agentId: AGENT_ID,
    merchantId: "juniper-and-thread",
    items: [{ sku: "silver-hoops", qty: 1 }],
    maxAmountCents: 6000,
    currency: "USD",
    createdAt: "2026-11-05T00:00:00.000Z",
    expiresAt: "2026-11-06T00:00:00.000Z",
    shopperPublicJwk: shopperPub as JsonWebKey,
    ...over,
  };
}

export async function signed(
  shopper: { priv: CryptoKey; pub: JWK },
  agent: { priv: CryptoKey },
  over: Partial<MandatePayload> = {},
  order: OrderRequest = { items: [{ sku: "silver-hoops", qty: 1 }], amountCents: 6000, currency: "USD" },
) {
  const p = mandatePayload(shopper.pub, over);
  return {
    payload: p,
    hash: canonicalHash(p),
    shopperJws: await signMandate(p, shopper.priv),
    agentJws: await signAgentRequest({ mandateHash: canonicalHash(p), orderRequest: order }, agent.priv, AGENT_ID),
  };
}
