import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { AGENT_ID, getAgentKeys, resetAgentKeysForTests } from "@/lib/agent/agent-keys";
import { GET } from "@/app/api/agent/.well-known/jwks/route";

afterEach(() => {
  delete process.env.SHOPPER_AGENT_PRIVATE_JWK;
  resetAgentKeysForTests();
  vi.restoreAllMocks();
});

describe("agent keys and JWKS", () => {
  it("serves only public key material (no d field) with the agent id as kid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET();
    const body = JSON.stringify(await res.json());
    expect(body).not.toMatch(/"d"/);
    const parsed = JSON.parse(body) as { keys: { kid: string; kty: string; crv: string; x: string }[] };
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]).toMatchObject({ kid: AGENT_ID, kty: "OKP", crv: "Ed25519" });
  });

  it("warns once when the key is ephemeral and reuses it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await getAgentKeys();
    const b = await getAgentKeys();
    expect(a.publicJwk.x).toBe(b.publicJwk.x);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses SHOPPER_AGENT_PRIVATE_JWK when set and still omits d from the JWKS", async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(privateKey);
    process.env.SHOPPER_AGENT_PRIVATE_JWK = JSON.stringify(jwk);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = (await (await GET()).json()) as { keys: Record<string, string>[] };
    expect(body.keys[0].x).toBe(jwk.x);
    expect(body.keys[0]).not.toHaveProperty("d");
    expect(warn).not.toHaveBeenCalled();
  });
});
