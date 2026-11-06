import { CompactSign, type JWK, type CryptoKey, type KeyObject } from "jose";
import type { MandatePayload } from "./mandate";

// Browser-safe: no node:* imports, so the wallet page can sign mandates client-side.

export type SigningKey = CryptoKey | KeyObject | JWK | Uint8Array;

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

export async function signMandate(payload: MandatePayload, shopperPrivateKey: SigningKey): Promise<string> {
  return new CompactSign(new TextEncoder().encode(canonicalJson(payload)))
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(shopperPrivateKey as CryptoKey);
}
