import { createHash } from "node:crypto";
import { CompactSign, compactVerify, importJWK, decodeProtectedHeader, type JWK, type CryptoKey, type KeyObject } from "jose";

export type MandateItem = { sku: string; qty: number };

export type MandatePayload = {
  mandateId: string;
  shopperEmail: string;
  agentId: string;
  merchantId: "juniper-and-thread";
  items: MandateItem[];
  maxAmountCents: number;
  currency: "USD";
  createdAt: string;
  expiresAt: string;
  shopperPublicJwk: JsonWebKey;
};

export type OrderRequest = { items: MandateItem[]; amountCents: number; currency: string };

export type MandateFailure =
  | "bad_shopper_signature"
  | "bad_agent_signature"
  | "expired"
  | "amount_over_max"
  | "item_not_in_mandate"
  | "currency_mismatch"
  | "agent_not_named"
  | "payer_email_mismatch"; // set later by recordCapturedOrder, never by verifyMandate

type SigningKey = CryptoKey | KeyObject | JWK | Uint8Array;

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, sortDeep(o[k])]),
    );
  }
  return v;
}

/** JSON with recursively sorted object keys, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Lowercase sha256 hex (64 chars) of the canonical JSON. */
export function canonicalHash(payload: MandatePayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

const enc = new TextEncoder();

export async function signMandate(payload: MandatePayload, shopperPrivateKey: SigningKey): Promise<string> {
  return new CompactSign(enc.encode(canonicalJson(payload)))
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(shopperPrivateKey as CryptoKey);
}

export async function signAgentRequest(
  body: { mandateHash: string; orderRequest: OrderRequest },
  agentPrivateKey: SigningKey,
  agentId: string,
): Promise<string> {
  return new CompactSign(enc.encode(canonicalJson(body)))
    .setProtectedHeader({ alg: "EdDSA", kid: agentId })
    .sign(agentPrivateKey as CryptoKey);
}

export function checkPayerMatch(payload: MandatePayload, paypalPayerEmail: string): boolean {
  return payload.shopperEmail.trim().toLowerCase() === paypalPayerEmail.trim().toLowerCase();
}

function decodePayload(jws: string): unknown {
  const part = jws.split(".")[1];
  if (!part) throw new Error("malformed JWS");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function verifyMandate(input: {
  shopperJws: string;
  agentJws: string;
  agentPublicJwk: JsonWebKey;
  order: OrderRequest;
  now: Date;
}): Promise<{ verified: boolean; payload?: MandatePayload; hash?: string; failures: MandateFailure[] }> {
  // 1. Shopper signature. The embedded key is read from the untrusted payload only to
  //    verify the signature; nothing else is evaluated unless it verifies.
  let payload: MandatePayload;
  try {
    const untrusted = decodePayload(input.shopperJws) as MandatePayload;
    const key = await importJWK(untrusted.shopperPublicJwk as JWK, "EdDSA");
    const { payload: bytes, protectedHeader } = await compactVerify(input.shopperJws, key, { algorithms: ["EdDSA"] });
    if (protectedHeader.alg !== "EdDSA") throw new Error("alg");
    payload = JSON.parse(new TextDecoder().decode(bytes)) as MandatePayload;
  } catch {
    return { verified: false, failures: ["bad_shopper_signature"] };
  }

  const hash = canonicalHash(payload);
  const failures: MandateFailure[] = [];

  // 2. Agent signature, binding to this mandate hash and this exact order.
  let agentOk = false;
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(input.agentJws).kid;
    const key = await importJWK(input.agentPublicJwk as JWK, "EdDSA");
    const { payload: bytes } = await compactVerify(input.agentJws, key, { algorithms: ["EdDSA"] });
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { mandateHash?: string; orderRequest?: unknown };
    agentOk =
      body.mandateHash === hash && canonicalJson(body.orderRequest) === canonicalJson(input.order);
  } catch {
    agentOk = false;
  }
  if (!agentOk) failures.push("bad_agent_signature");
  if (kid !== payload.agentId) failures.push("agent_not_named");

  // 3. Policy checks against the signed mandate.
  if (input.now.getTime() > Date.parse(payload.expiresAt) || Number.isNaN(Date.parse(payload.expiresAt))) failures.push("expired");
  if (input.order.amountCents > payload.maxAmountCents) failures.push("amount_over_max");
  if (input.order.currency !== payload.currency) failures.push("currency_mismatch");

  const allowed = new Map<string, number>();
  for (const i of payload.items) allowed.set(i.sku, (allowed.get(i.sku) ?? 0) + i.qty);
  const requested = new Map<string, number>();
  for (const i of input.order.items) requested.set(i.sku, (requested.get(i.sku) ?? 0) + i.qty);
  for (const [sku, qty] of requested) {
    if (!allowed.has(sku) || qty > allowed.get(sku)!) {
      failures.push("item_not_in_mandate");
      break;
    }
  }

  return { verified: failures.length === 0, payload, hash, failures };
}
