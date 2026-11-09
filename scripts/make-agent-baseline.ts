// Creates the real "agent_verified" baseline order end to end in the PayPal sandbox:
//   fresh shopper key -> signed mandate (shopperEmail = SANDBOX_BUYER_EMAIL, silver-hoops, max $60, 24h)
//   -> agentCheckout (our merchant path, agent signature from SHOPPER_AGENT_PRIVATE_JWK)
//   -> sandbox buyer approves in Chrome (scripts/sandbox-approve.py)
//   -> captureAndRecord (links the mandate, checks payer email and the PayPal custom_id)
//   -> appends { orderId, scenario: "agent_verified" } to scripts/baseline-orders.json.
// Run: npx tsx scripts/make-agent-baseline.ts   (needs real DATABASE_URL, PayPal sandbox keys, SANDBOX_BUYER_*; then npm run seed)
// Never prints secrets or the buyer email.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { getAgentKeys, AGENT_ID } from "../src/lib/agent/agent-keys";
import { agentCheckout, buildOrderRequest } from "../src/lib/agent/checkout";
import { closeDb, getDb } from "../src/lib/db/client";
import { mandates } from "../src/lib/db/schema";
import { buildEvidenceFolder } from "../src/lib/evidence/folder";
import { canonicalHash, signAgentRequest, signMandate, type MandatePayload } from "../src/lib/mandate/mandate";
import { captureAndRecord } from "../src/lib/orders/capture";
import { getOrder } from "../src/lib/paypal/orders";

const SKU = process.argv[2] ?? "silver-hoops";
const MAX_CENTS = 6000;
const BASELINE = path.join(process.cwd(), "scripts", "baseline-orders.json");

async function freshMandate(shopperEmail: string) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const now = new Date();
  const payload: MandatePayload = {
    mandateId: crypto.randomUUID(),
    shopperEmail,
    agentId: AGENT_ID,
    merchantId: "juniper-and-thread",
    items: [{ sku: SKU, qty: 1 }],
    maxAmountCents: MAX_CENTS,
    currency: "USD",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    shopperPublicJwk: (await exportJWK(publicKey)) as JWK as JsonWebKey,
  };
  return { payload, shopperJws: await signMandate(payload, privateKey) };
}

async function waitForApproval(orderId: string, tries = 10): Promise<string> {
  let status = "";
  for (let i = 0; i < tries; i++) {
    status = String(((await getOrder(orderId)) as { status?: unknown }).status ?? "");
    if (status === "APPROVED" || status === "COMPLETED") return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return status;
}

async function main() {
  const shopperEmail = process.env.SANDBOX_BUYER_EMAIL?.trim();
  if (!shopperEmail) throw new Error("SANDBOX_BUYER_EMAIL is not set");
  if (!process.env.SHOPPER_AGENT_PRIVATE_JWK?.trim()) throw new Error("SHOPPER_AGENT_PRIVATE_JWK is not set (the order would be signed by a throwaway key)");
  const db = getDb();

  const { payload, shopperJws } = await freshMandate(shopperEmail);
  const orderRequest = buildOrderRequest(payload.items);
  if (!orderRequest) throw new Error(`Unknown sku ${SKU}`);
  const agent = await getAgentKeys();
  const agentJws = await signAgentRequest({ mandateHash: canonicalHash(payload), orderRequest }, agent.privateKey, agent.agentId);

  const t0 = Date.now();
  const checkout = await agentCheckout(db, { shopperJws, agentJws, items: payload.items });
  if (checkout.status !== 200) throw new Error(`agentCheckout ${checkout.status}: ${JSON.stringify(checkout.data)}`);
  const { orderId, approveUrl, mandateId } = checkout.data;
  console.log(`agentCheckout ok in ${Date.now() - t0} ms: order ${orderId}, mandate ${mandateId}`);

  const approve = spawnSync("python", [path.join("scripts", "sandbox-approve.py"), approveUrl], { stdio: "inherit" });
  if (approve.status !== 0) console.warn("sandbox-approve.py did not confirm the redirect; checking the order status anyway.");
  const status = await waitForApproval(orderId);
  if (status !== "APPROVED" && status !== "COMPLETED") throw new Error(`Order ${orderId} is ${status || "unknown"}, not APPROVED. Approve it at the PayPal URL and run captureAndRecord.`);

  const row = await captureAndRecord(db, orderId);
  const [m] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
  const ev = (await buildEvidenceFolder(db, { orderId })).find((e) => e.kind === "mandate");
  console.log(
    JSON.stringify(
      {
        orderId,
        captureId: row.captureId,
        source: row.source,
        mandateLinked: row.mandateId === mandateId,
        verified: m?.verified,
        payerEmailMatch: m?.payerEmailMatch,
        paypalCustomIdMatch: m?.paypalCustomIdMatch,
        evidenceSaysVerified: !!ev && ev.summary.includes("verified: true"),
        evidenceSaysCustomIdMatches: !!ev && ev.summary.includes("(matches)"),
      },
      null,
      1,
    ),
  );

  const list = JSON.parse(readFileSync(BASELINE, "utf8")) as { orderId: string; scenario: string }[];
  if (!list.some((e) => e.orderId === orderId)) {
    list.push({ orderId, scenario: "agent_verified" });
    writeFileSync(BASELINE, `[\n${list.map((e) => `  ${JSON.stringify(e).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }")}`).join(",\n")}\n]\n`);
    console.log(`Added ${orderId} to scripts/baseline-orders.json as agent_verified. Run npm run seed.`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
