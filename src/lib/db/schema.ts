import { boolean, customType, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
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

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  carrier: text("carrier").notNull(),
  trackingNumber: text("tracking_number").notNull(),
  pushedToPaypal: boolean("pushed_to_paypal").notNull().default(false),
  pushedAt: ts("pushed_at"),
  signatureRequired: boolean("signature_required").notNull().default(false),
  status: text("status", { enum: ["label", "in_transit", "delivered"] }).notNull().default("label"),
  deliveredAt: ts("delivered_at"),
  simulated: boolean("simulated").notNull().default(true),
  shipToAddress: jsonb("ship_to_address"),
});

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
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const disputes = pgTable("disputes", {
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
});

export const cases = pgTable("cases", {
  id: text("id").primaryKey(),
  disputeId: text("dispute_id").notNull().references(() => disputes.id),
  recommendation: jsonb("recommendation"),
  draft: jsonb("draft"),
  pdfBytes: bytea("pdf_bytes"),
  submittedAt: ts("submitted_at"),
  submitResult: jsonb("submit_result"),
  usedFallback: boolean("used_fallback").notNull().default(false),
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
