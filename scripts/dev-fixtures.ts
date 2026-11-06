// DEV ONLY: inserts a handful of clearly fake local rows so the dashboard can be developed and screenshotted.
// Run: npm run dev:fixtures   (with DATABASE_URL empty -> writes to the local PGlite file at .data/pglite)
// Stop `next dev` first: the local database is a single-process file. Re-running replaces the fixture rows.
// Every row id starts with DEVFIX; orders carry raw.devFixture = true so tracking pushes never reach PayPal;
// disputes and demo deliveries are marked simulated. Task 14 builds the real seed from sandbox orders.
import "dotenv/config";
import { createHash } from "node:crypto";
import { like, or } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";
import { closeDevDb } from "../src/lib/db/dev-pglite";
import { resolveDbMode } from "../src/lib/db/mode";
import { cases, disputes, mandates, messages, orders, protectionChecks, shipments } from "../src/lib/db/schema";
import { getProduct } from "../src/lib/catalog";
import { buildCase } from "../src/lib/defense/build-case";
import { recomputeProtection } from "../src/lib/protection/refresh";
import type { Address } from "../src/lib/paypal/types";

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3_600_000);
const ahead = (days: number, hours = 0) => new Date(now + days * DAY + hours * 3_600_000);

type Fixture = {
  id: string;
  daysAgo: number;
  source: "human" | "agent";
  name: string;
  email: string;
  address: Address;
  items: { sku: string; qty: number }[];
  shipment?: { carrier: string; tracking: string; pushed: boolean; delivered: boolean; shipTo?: Address };
  mandate?: { verified: boolean; failures: string[]; payerEmailMatch: boolean };
};

const addr = (line1: string, city: string, state: string, postalCode: string): Address => ({ line1, city, state, postalCode, countryCode: "US" });

const FIXTURES: Fixture[] = [
  { id: "DEVFIX-1001", daysAgo: 9, source: "human", name: "Ava Thompson", email: "ava.thompson@example.com",
    address: addr("418 Larkspur Ave", "Austin", "TX", "78704"), items: [{ sku: "silver-hoops", qty: 1 }],
    shipment: { carrier: "USPS", tracking: "9400110000000000001001", pushed: true, delivered: true } },
  { id: "DEVFIX-1002", daysAgo: 3, source: "human", name: "Daniel Ortiz", email: "d.ortiz@example.com",
    address: addr("77 Harbor View Rd", "San Diego", "CA", "92101"), items: [{ sku: "heirloom-necklace", qty: 1 }],
    shipment: { carrier: "UPS", tracking: "1Z999AA10000001002", pushed: true, delivered: false } },
  { id: "DEVFIX-1003", daysAgo: 6, source: "human", name: "Priya Natarajan", email: "priya.n@example.com",
    address: addr("2210 Maple Ct", "Madison", "WI", "53703"), items: [{ sku: "juniper-pendant", qty: 1 }, { sku: "woven-cuff", qty: 1 }],
    shipment: { carrier: "USPS", tracking: "9400110000000000001003", pushed: false, delivered: true } },
  { id: "DEVFIX-1004", daysAgo: 1, source: "human", name: "Marcus Lee", email: "marcus.lee@example.com",
    address: addr("9 Cedar Hollow", "Asheville", "NC", "28801"), items: [{ sku: "moonstone-ring", qty: 1 }] },
  { id: "DEVFIX-1005", daysAgo: 7, source: "human", name: "Hannah Becker", email: "hannah.becker@example.com",
    address: addr("31 Birch St", "Boulder", "CO", "80302"), items: [{ sku: "silver-hoops", qty: 2 }],
    shipment: { carrier: "USPS", tracking: "9400110000000000001005", pushed: true, delivered: false, shipTo: addr("1450 Pearl St Apt 5", "Boulder", "CO", "80302") } },
  { id: "DEVFIX-1006", daysAgo: 2, source: "human", name: "Olivia Grant", email: "olivia@grant-boutique.example.com",
    address: addr("600 Market St", "Philadelphia", "PA", "19106"), items: [{ sku: "heirloom-necklace", qty: 12 }],
    shipment: { carrier: "FEDEX", tracking: "770000001006", pushed: true, delivered: false } },
  { id: "DEVFIX-1007", daysAgo: 5, source: "agent", name: "Jordan Rivera", email: "jordan.rivera@example.com",
    address: addr("88 Willow Lane", "Portland", "ME", "04101"), items: [{ sku: "juniper-pendant", qty: 1 }],
    shipment: { carrier: "USPS", tracking: "9400110000000000001007", pushed: true, delivered: true },
    mandate: { verified: true, failures: [], payerEmailMatch: true } },
  { id: "DEVFIX-1008", daysAgo: 0, source: "agent", name: "Sam Patel", email: "sam.patel@example.com",
    address: addr("12 Orchard Way", "Columbus", "OH", "43215"), items: [{ sku: "woven-cuff", qty: 1 }],
    mandate: { verified: false, failures: ["payer_email_mismatch"], payerEmailMatch: false } },
];

type DisputeFixture = {
  id: string; orderId: string; reason: string; stage: string; dueIn: Date; openedDaysAgo: number; message: string; build?: boolean;
};

const DISPUTES: DisputeFixture[] = [
  { id: "PP-D-DEVFIX-01", orderId: "DEVFIX-1001", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", stage: "INQUIRY",
    dueIn: ahead(6, 4), openedDaysAgo: 1, message: "My hoops never arrived. The tracking says delivered but there was nothing in my mailbox." },
  { id: "PP-D-DEVFIX-02", orderId: "DEVFIX-1007", reason: "UNAUTHORISED", stage: "CHARGEBACK",
    dueIn: ahead(1, 20), openedDaysAgo: 2, message: "I never bought this pendant. My AI assistant must have ordered it on its own.", build: true },
  { id: "PP-D-DEVFIX-03", orderId: "DEVFIX-1003", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", stage: "CLAIM",
    dueIn: ahead(4, 2), openedDaysAgo: 1, message: "The clasp on the cuff is silver, but the photo showed brass." },
];

async function main() {
  if (resolveDbMode(process.env) !== "dev-pglite") {
    console.error("dev:fixtures only writes to the local dev database. Unset DATABASE_URL (and NODE_ENV=production) to use it.");
    process.exit(1);
  }
  const db = getDb();

  // Replace any earlier fixture rows (children first).
  await db.delete(cases).where(like(cases.disputeId, "PP-D-DEVFIX-%"));
  await db.delete(messages).where(or(like(messages.orderId, "DEVFIX-%"), like(messages.disputeId, "PP-D-DEVFIX-%")));
  await db.delete(disputes).where(like(disputes.id, "PP-D-DEVFIX-%"));
  await db.delete(protectionChecks).where(like(protectionChecks.orderId, "DEVFIX-%"));
  await db.delete(shipments).where(like(shipments.orderId, "DEVFIX-%"));
  await db.delete(mandates).where(like(mandates.id, "mdt_devfix_%"));
  await db.delete(orders).where(like(orders.id, "DEVFIX-%"));

  for (const f of FIXTURES) {
    const lines = f.items.map((i) => {
      const p = getProduct(i.sku)!;
      return { sku: p.sku, name: p.name, qty: i.qty, priceCents: p.priceCents };
    });
    const amountCents = lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
    const createdAt = ago(f.daysAgo, 3);
    const mandateId = f.mandate ? `mdt_devfix_${f.id.slice(-4)}` : null;

    await db.insert(orders).values({
      id: f.id, source: f.source, status: "COMPLETED", amountCents, currency: "USD",
      buyerEmail: f.email, payerId: `DEVFIXPAYER${f.id.slice(-4)}`, shipName: f.name, shipAddress: f.address,
      items: lines, captureId: `DEVFIX-CAP-${f.id.slice(-4)}`, mandateId, createdAt, approvedAt: new Date(createdAt.getTime() + 60_000),
      raw: { devFixture: true },
    });

    if (f.mandate && mandateId) {
      const payload = {
        mandateId, shopperEmail: f.email, agentId: "juniper-shopper-agent", merchantId: "juniper-and-thread",
        items: f.items, maxAmountCents: amountCents + 1000, currency: "USD",
        createdAt: new Date(createdAt.getTime() - 3_600_000).toISOString(), expiresAt: ahead(30).toISOString(), shopperPublicJwk: {},
      };
      await db.insert(mandates).values({
        id: mandateId, orderId: f.id, payload, shopperJws: "dev-fixture-not-a-signature", agentJws: "dev-fixture-not-a-signature",
        hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        verified: f.mandate.verified, failures: f.mandate.failures, payerEmailMatch: f.mandate.payerEmailMatch,
      });
    }

    if (f.shipment) {
      const s = f.shipment;
      await db.insert(shipments).values({
        id: `shp_devfix_${f.id.slice(-4)}`, orderId: f.id, carrier: s.carrier, trackingNumber: s.tracking,
        pushedToPaypal: s.pushed, pushedAt: s.pushed ? ago(f.daysAgo - 1) : null,
        status: s.delivered ? "delivered" : "in_transit", deliveredAt: s.delivered ? ago(Math.max(0, f.daysAgo - 3)) : null,
        simulated: s.delivered, shipToAddress: s.shipTo ?? f.address,
      });
    }
    await recomputeProtection(db, f.id);
  }

  await db.insert(messages).values({
    id: "msg_devfix_1003", orderId: "DEVFIX-1003", author: "buyer", source: "storefront", createdAt: ago(6, 1),
    body: "Hi Maya! Could you wrap the pendant? It's a birthday gift.",
  });

  for (const d of DISPUTES) {
    const [o] = await db.select().from(orders).where(like(orders.id, d.orderId));
    const opened = ago(d.openedDaysAgo);
    await db.insert(disputes).values({
      id: d.id, orderId: o.id, captureId: o.captureId, reason: d.reason, status: "WAITING_FOR_SELLER_RESPONSE", stage: d.stage,
      amountCents: o.amountCents, currency: o.currency, sellerResponseDue: d.dueIn, simulated: true, lastEventAt: opened,
      raw: { dispute_id: d.id, create_time: opened.toISOString(), devFixture: true },
    });
    await db.insert(messages).values({
      id: `msg_${d.id}`, orderId: o.id, disputeId: d.id, author: "buyer", source: "paypal_dispute", body: d.message,
      createdAt: new Date(opened.getTime() + 600_000),
    });
    if (d.build) await buildCase(db, d.id, { deps: { gather: async () => [] } });
  }

  console.log(`Inserted ${FIXTURES.length} fixture orders and ${DISPUTES.length} simulated disputes (one case pre-built).`);
  await closeDevDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDevDb().catch(() => {});
  process.exit(1);
});
