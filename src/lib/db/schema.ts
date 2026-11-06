import { sql } from "drizzle-orm";
import { boolean, customType, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Always reads back as Uint8Array (PGlite returns Uint8Array, postgres-js a Buffer). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (v) => new Uint8Array(v),
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const orders = pgTable("orders", {
  id: text("id").primaryKey(), // PayPal order id
  source: text("source", { enum: ["human", "agent"] }).notNull(),
  status: text("status").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  buyerEmail: text("buyer_email"),
  payerId: text("payer_id"),
  shipName: text("ship_name"),
  shipAddress: jsonb("ship_address"),
  items: jsonb("items").notNull(),
  captureId: text("capture_id"),
  mandateId: text("mandate_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  approvedAt: ts("approved_at"),
  raw: jsonb("raw"),
});

/** One shipment per order (unique order_id), so adding tracking is race-safe and an unpushed one can be replaced. */
export const shipments = pgTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    carrier: text("carrier").notNull(),
    trackingNumber: text("tracking_number").notNull(),
    pushedToPaypal: boolean("pushed_to_paypal").notNull().default(false),
    pushedAt: ts("pushed_at"),
    /** True when the push never reached PayPal (local dev fixture orders); shown as "Simulated push". */
    pushSimulated: boolean("push_simulated").notNull().default(false),
    signatureRequired: boolean("signature_required").notNull().default(false),
    status: text("status", { enum: ["label", "in_transit", "delivered"] }).notNull().default("label"),
    deliveredAt: ts("delivered_at"),
    simulated: boolean("simulated").notNull().default(true),
    shipToAddress: jsonb("ship_to_address"),
  },
  (t) => [uniqueIndex("shipments_order_id_unique").on(t.orderId)],
);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  orderId: text("order_id").references(() => orders.id),
  disputeId: text("dispute_id"),
  author: text("author", { enum: ["buyer", "seller", "paypal"] }).notNull(),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  source: text("source", { enum: ["storefront", "paypal_dispute"] }).notNull(),
});

export const mandates = pgTable("mandates", {
  id: text("id").primaryKey(),
  orderId: text("order_id"),
  payload: jsonb("payload").notNull(),
  shopperJws: text("shopper_jws").notNull(),
  agentJws: text("agent_jws").notNull(),
  hash: text("hash").notNull(),
  verified: boolean("verified").notNull(),
  failures: jsonb("failures"),
  payerEmailMatch: boolean("payer_email_match"),
  /** PayPal order custom_id read back at capture equals `hash`. Null: not checked (e.g. captured before this check). */
  paypalCustomIdMatch: boolean("paypal_custom_id_match"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(), // PayPal dispute id
    orderId: text("order_id"),
    captureId: text("capture_id"),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    sellerResponseDue: ts("seller_response_due"),
    simulated: boolean("simulated").notNull().default(false),
    outcome: text("outcome"),
    lastEventAt: ts("last_event_at"),
    raw: jsonb("raw"),
  },
  // At most one open simulated dispute per order, enforced by the database so concurrent judges cannot race past it.
  (t) => [uniqueIndex("disputes_one_open_sim_per_order").on(t.orderId).where(sql`${t.simulated} and ${t.status} <> 'RESOLVED'`)],
);

export const cases = pgTable("cases", {
  id: text("id").primaryKey(),
  disputeId: text("dispute_id").notNull().references(() => disputes.id),
  recommendation: jsonb("recommendation"),
  draft: jsonb("draft"),
  pdfBytes: bytea("pdf_bytes"),
  submittedAt: ts("submitted_at"),
  submitResult: jsonb("submit_result"),
  usedFallback: boolean("used_fallback").notNull().default(false),
  builtAt: ts("built_at").notNull().defaultNow(),
  /** Set while a seller action (submit/offer/accept) is running; claimed atomically, stale after 60s. */
  actionInFlightAt: ts("action_in_flight_at"),
});

export const protectionChecks = pgTable("protection_checks", {
  orderId: text("order_id").primaryKey().references(() => orders.id),
  result: jsonb("result").notNull(),
  explanation: jsonb("explanation"),
  checkedAt: ts("checked_at").notNull().defaultNow(),
});

export const aiUsage = pgTable("ai_usage", {
  day: text("day").primaryKey(), // YYYY-MM-DD UTC
  calls: integer("calls").notNull().default(0),
});

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // PayPal event id
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

/** Small key/value store for demo bookkeeping (e.g. the global reset cooldown). */
export const demoState = pgTable("demo_state", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
