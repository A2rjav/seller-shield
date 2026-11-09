import { eq, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { resolveDbMode } from "@/lib/db/mode";
import { disputes, mandates, orders, shipments } from "@/lib/db/schema";
import { mapCapturedOrder, mapOrderItems, readTrackers } from "@/lib/paypal/orders";
import type { AddTrackingInput } from "@/lib/paypal/tracking";
import type { Address } from "@/lib/paypal/types";
import { recordCapturedOrder } from "@/lib/orders/record";
import { recomputeProtection } from "@/lib/protection/refresh";
import { addShipment, markDeliveredSimulated, pushTrackingToPaypal } from "@/lib/shipments/service";
import { loadBaseline, type BaselineEntry } from "./baseline";
import { createSimulatedDispute } from "./simulate";

export type { BaselineEntry, Scenario } from "./baseline";

export type SeedDeps = {
  /** PayPal GET order (injectable for tests). */
  getOrder: (id: string) => Promise<unknown>;
  /** PayPal add-tracking (injectable for tests); defaults to the real sandbox call. */
  addTracking?: (input: AddTrackingInput) => Promise<void>;
  entries?: BaselineEntry[];
};
/** `failures` counts orders that could not be seeded (PayPal or DB errors); a by-design skip (no mandate) is only a warning. */
export type SeedResult = { seeded: number; failures: number; warnings: string[] };

/** Null when it is safe to seed; otherwise why not. The dev PGlite fallback needs an explicit `--dev`. */
export function seedModeError(env: Record<string, string | undefined>, dev: boolean): string | null {
  if (resolveDbMode(env) === "dev-pglite" && !dev) {
    return "DATABASE_URL is empty, so this would seed the local dev database. Set a real DATABASE_URL, or pass --dev to seed the local dev database on purpose.";
  }
  return null;
}

/** Error text for a warning. Drizzle wraps driver errors as "Failed query: <sql>", so the driver's own message (the cause) is what explains it. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "seed failed";
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${e.message.split("\n")[0]} (cause: ${cause.message})`;
  return e.message;
}

/** Random 22-digit USPS-style test number, so a re-created unpushed shipment never reuses a number already on PayPal. */
const freshTracking = () => `94${Array.from({ length: 20 }, () => Math.floor(Math.random() * 10)).join("")}`;

const trackingFor = (orderId: string) => `JT${orderId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16).toUpperCase()}`.padEnd(12, "0");

function otherStreet(a: Address | null): Address {
  return { ...(a ?? { city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" }), line1: "1450 Pearl Street Unit 5", line2: undefined } as Address;
}

async function currentShipment(db: Db, orderId: string) {
  const [s] = await db.select().from(shipments).where(eq(shipments.orderId, orderId));
  return s;
}

/**
 * Local shipment/dispute data for one scenario. PayPal writes: add-tracking, once, and only if not already pushed.
 * Tracking PayPal already holds for the order (`paypalOrder` trackers) is adopted as the pushed shipment instead of adding a second tracker,
 * so a fresh database never stacks demo trackers on a real order.
 */
async function applyScenario(db: Db, entry: BaselineEntry, deps: SeedDeps, warnings: string[], paypalOrder: unknown) {
  const { orderId, scenario } = entry;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const carrier = scenario === "awaiting_delivery_850" ? "UPS" : "USPS";
  const onPaypal = readTrackers(paypalOrder)[0];
  if (onPaypal && scenario === "tracking_not_pushed") {
    warnings.push(`${orderId}: PayPal already holds tracking for this order, so it cannot demonstrate "tracking not pushed". Use an order without tracking.`);
  }
  // Scenario tracking numbers are made up by the demo, and delivery is simulated, so these shipments stay flagged simulated.
  const ship = async (shipTo?: Address) => {
    const existing = await currentShipment(db, orderId);
    if (existing) return existing;
    const adopt = onPaypal && scenario !== "tracking_not_pushed" ? onPaypal : null;
    const trackingNumber = adopt ? adopt.trackingNumber : scenario === "tracking_not_pushed" ? freshTracking() : trackingFor(orderId);
    const added = await addShipment(db, orderId, {
      carrier: adopt?.carrier ?? carrier,
      trackingNumber,
      ...(shipTo ? { shipToAddress: shipTo } : {}),
    });
    const [row] = await db
      .update(shipments)
      .set({ simulated: true, ...(adopt ? { pushedToPaypal: true, pushedAt: new Date(), pushSimulated: false } : {}) })
      .where(eq(shipments.id, added.id))
      .returning();
    return row;
  };
  const push = async (s: { id: string; pushedToPaypal: boolean }) => {
    if (s.pushedToPaypal) return;
    try {
      await pushTrackingToPaypal(db, s.id, { addTracking: deps.addTracking });
    } catch (e) {
      warnings.push(`${orderId}: tracking was not pushed to PayPal (${e instanceof Error ? e.message : "error"}).`);
    }
  };
  const inTransit = (id: string) => db.update(shipments).set({ status: "in_transit", deliveredAt: null }).where(eq(shipments.id, id));

  switch (scenario) {
    case "protected_delivered":
    case "agent_verified": {
      const s = await ship();
      await push(s);
      if (s.status !== "delivered") await markDeliveredSimulated(db, s.id);
      break;
    }
    case "address_mismatch": {
      const s = await ship(otherStreet(order?.shipAddress as Address | null));
      await push(s);
      if (s.status === "label") await inTransit(s.id);
      break;
    }
    case "awaiting_delivery_850": {
      const s = await ship();
      await push(s);
      if (s.status !== "in_transit") await inTransit(s.id);
      break;
    }
    case "tracking_not_pushed":
      await ship();
      break;
    case "dispute_item_not_received": {
      const s = await ship();
      await push(s);
      if (s.status !== "delivered") await markDeliveredSimulated(db, s.id);
      const [existing] = await db.select({ id: disputes.id }).from(disputes).where(eq(disputes.orderId, orderId));
      if (!existing) await createSimulatedDispute(db, orderId, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
      break;
    }
  }
}

/**
 * Re-fetches each baseline order from PayPal (sandbox), stores it, and applies its local scenario data.
 * Idempotent: running it twice yields the same rows and no repeated PayPal writes. A failing order is skipped with a warning.
 */
export async function seedDemo(db: Db, deps: SeedDeps): Promise<SeedResult> {
  const warnings: string[] = [];
  let seeded = 0;
  let failures = 0;
  for (const entry of deps.entries ?? loadBaseline()) {
    const { orderId, scenario } = entry;
    try {
      const res = await deps.getOrder(orderId);
      const captured = mapCapturedOrder(res);
      if (!captured) {
        warnings.push(`${orderId}: PayPal returned no capture, skipped.`);
        failures++;
        continue;
      }
      const [existing] = await db.select().from(orders).where(eq(orders.id, orderId));
      let mandateId: string | undefined;
      if (scenario === "agent_verified") {
        const [m] = await db
          .select({ id: mandates.id })
          .from(mandates)
          .where(existing?.mandateId ? or(eq(mandates.orderId, orderId), eq(mandates.id, existing.mandateId)) : eq(mandates.orderId, orderId));
        if (!m) {
          warnings.push(`${orderId}: agent_verified needs an existing mandate for this order (buy it through the agent first), skipped.`);
          continue;
        }
        mandateId = m.id;
      }
      await recordCapturedOrder(db, {
        ...captured,
        orderId,
        source: scenario === "agent_verified" ? "agent" : (existing?.source ?? "human"),
        items: mapOrderItems(res),
        ...(mandateId ? { mandateId } : {}),
      });
      await applyScenario(db, entry, deps, warnings, res);
      await recomputeProtection(db, orderId);
      seeded++;
    } catch (e) {
      warnings.push(`${orderId}: ${describeError(e)}`);
      failures++;
    }
  }
  return { seeded, failures, warnings };
}
