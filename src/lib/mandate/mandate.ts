import { createHash } from "node:crypto";
import { z } from "zod";
import { CompactSign, compactVerify, importJWK, decodeProtectedHeader, type JWK } from "jose";
import { canonicalJson, type SigningKey } from "./sign";

export { canonicalJson, signMandate } from "./sign";

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
  | "malformed_mandate"
  | "invalid_order"
  | "payer_email_mismatch"; // set later by recordCapturedOrder, never by verifyMandate

/** Lowercase sha256 hex (64 chars) of the canonical JSON. */
export function canonicalHash(payload: MandatePayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

const nonEmpty = z.string().min(1);
const itemSchema = z.object({ sku: nonEmpty, qty: z.number().int().positive() });
const iso = z.string().datetime({ offset: true });
const payloadSchema = z.object({
  mandateId: nonEmpty,
  shopperEmail: nonEmpty,
  agentId: nonEmpty,
  merchantId: z.literal("juniper-and-thread"),
  items: z.array(itemSchema).min(1),
  maxAmountCents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  createdAt: iso,
  expiresAt: iso,
  shopperPublicJwk: z.record(z.unknown()),
});
const orderSchema = z.object({
  items: z.array(itemSchema).min(1),
  amountCents: z.number().int().nonnegative(),
  currency: nonEmpty,
});

const enc = new TextEncoder();

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

type VerifyInput = {
  shopperJws: string;
  agentJws: string;
  agentPublicJwk: JsonWebKey;
  order: OrderRequest;
  now: Date;
};
type VerifyResult = { verified: boolean; payload?: MandatePayload; hash?: string; failures: MandateFailure[] };

/** Never throws: any unexpected error fails closed. */
export async function verifyMandate(input: VerifyInput): Promise<VerifyResult> {
  try {
    return await verifyMandateInner(input);
  } catch {
    return { verified: false, failures: ["bad_shopper_signature"] };
  }
}

async function verifyMandateInner(input: VerifyInput): Promise<VerifyResult> {
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

  if (!payloadSchema.safeParse(payload).success) {
    return { verified: false, failures: ["malformed_mandate"] };
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
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime()) || input.now.getTime() > Date.parse(payload.expiresAt)) failures.push("expired");

  if (!orderSchema.safeParse(input.order).success) {
    failures.push("invalid_order");
    if (typeof input.order?.currency === "string" && input.order.currency !== payload.currency) failures.push("currency_mismatch");
  } else {
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
  }

  return { verified: failures.length === 0, payload, hash, failures };
}
