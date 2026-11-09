// Live check of the shopper agent: signs a fresh single-use mandate for the sandbox buyer (silver-hoops, max $60, 24h)
// and posts "Please buy the silver hoop earrings" to the real /api/agent/chat route handler (Gemini + agentCheckout + PayPal sandbox).
// Expect a checkout event with a sandbox approve URL. The order is left unapproved. Never prints the buyer email or the approve token.
// Run: npx tsx scripts/live-shopper-check.ts
import "dotenv/config";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { AGENT_ID } from "../src/lib/agent/agent-keys";
import type { AgentEvent } from "../src/lib/agent/shopper-agent";
import { POST } from "../src/app/api/agent/chat/route";
import { closeDb } from "../src/lib/db/client";
import { signMandate, type MandatePayload } from "../src/lib/mandate/mandate";

async function main() {
  const email = process.env.SANDBOX_BUYER_EMAIL?.trim();
  if (!email) throw new Error("SANDBOX_BUYER_EMAIL is not set");
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const now = new Date();
  const payload: MandatePayload = {
    mandateId: crypto.randomUUID(),
    shopperEmail: email,
    agentId: AGENT_ID,
    merchantId: "juniper-and-thread",
    items: [{ sku: "silver-hoops", qty: 1 }],
    maxAmountCents: 6000,
    currency: "USD",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    shopperPublicJwk: (await exportJWK(publicKey)) as JWK as JsonWebKey,
  };
  const shopperJws = await signMandate(payload, privateKey);
  const t = Date.now();
  const res = await POST(
    new Request("http://local/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ shopperJws, mode: "ai", messages: [{ role: "user", content: "Please buy the silver hoop earrings" }] }),
    }),
  );
  const body = (await res.json()) as { text?: string; events?: AgentEvent[]; aiUnavailable?: boolean; error?: string };
  const events = (body.events ?? []).map((e) =>
    e.type === "checkout" ? { type: e.type, orderId: e.orderId, totalCents: e.totalCents, approveHost: new URL(e.approveUrl).host, items: e.items } : e,
  );
  console.log(JSON.stringify({ ms: Date.now() - t, http: res.status, aiUnavailable: body.aiUnavailable ?? false, error: body.error, text: body.text, events }, null, 1));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
