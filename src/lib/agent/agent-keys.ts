import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export const AGENT_ID = "shopper-agent-demo-1";

export type AgentKeys = {
  agentId: string;
  privateKey: CryptoKey;
  /** Public half only (kty, crv, x, kid, alg, use). Safe to publish. */
  publicJwk: JsonWebKey & { kid: string; x: string };
};

const g = globalThis as { __agentKeys?: Promise<AgentKeys> };

function publicOnly(jwk: JWK) {
  return { kty: "OKP", crv: "Ed25519", x: String(jwk.x), kid: AGENT_ID, alg: "EdDSA", use: "sig" } as AgentKeys["publicJwk"];
}

async function load(): Promise<AgentKeys> {
  const raw = process.env.SHOPPER_AGENT_PRIVATE_JWK?.trim();
  if (raw) {
    const jwk = JSON.parse(raw) as JWK;
    const privateKey = (await importJWK(jwk, "EdDSA")) as CryptoKey;
    return { agentId: AGENT_ID, privateKey, publicJwk: publicOnly(jwk) };
  }
  console.warn("SHOPPER_AGENT_PRIVATE_JWK is not set: using an ephemeral demo agent key for this process.");
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { agentId: AGENT_ID, privateKey: privateKey as CryptoKey, publicJwk: publicOnly(await exportJWK(publicKey)) };
}

/** The demo shopper agent signing key, loaded once per process. */
export function getAgentKeys(): Promise<AgentKeys> {
  g.__agentKeys ??= load().catch((e) => {
    g.__agentKeys = undefined;
    throw e;
  });
  return g.__agentKeys;
}

export function resetAgentKeysForTests(): void {
  g.__agentKeys = undefined;
}
