import baselineJson from "../../../scripts/baseline-orders.json";

export const SCENARIOS = [
  "protected_delivered",
  "address_mismatch",
  "awaiting_delivery_850",
  "tracking_not_pushed",
  "agent_verified",
  "dispute_item_not_received",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** A real captured sandbox order (made during development) plus the local scenario the demo applies to it. */
export type BaselineEntry = { orderId: string; scenario: Scenario };

/** `scripts/baseline-orders.json`, bundled at build time so the hosted app and `npm run seed` read the same list. */
export function loadBaseline(): BaselineEntry[] {
  return (baselineJson as BaselineEntry[]).filter((e) => e && typeof e.orderId === "string" && (SCENARIOS as readonly string[]).includes(e.scenario));
}
