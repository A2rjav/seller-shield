CREATE TABLE "ai_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"recommendation" jsonb,
	"draft" jsonb,
	"pdf_bytes" "bytea",
	"submitted_at" timestamp with time zone,
	"submit_result" jsonb,
	"used_fallback" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"capture_id" text,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"seller_response_due" timestamp with time zone,
	"simulated" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"last_event_at" timestamp with time zone,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"payload" jsonb NOT NULL,
	"shopper_jws" text NOT NULL,
	"agent_jws" text NOT NULL,
	"hash" text NOT NULL,
	"verified" boolean NOT NULL,
	"failures" jsonb,
	"payer_email_match" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"dispute_id" text,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"buyer_email" text,
	"payer_id" text,
	"ship_name" text,
	"ship_address" jsonb,
	"items" jsonb NOT NULL,
	"capture_id" text,
	"mandate_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "protection_checks" (
	"order_id" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"explanation" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"carrier" text NOT NULL,
	"tracking_number" text NOT NULL,
	"pushed_to_paypal" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone,
	"signature_required" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'label' NOT NULL,
	"delivered_at" timestamp with time zone,
	"simulated" boolean DEFAULT true NOT NULL,
	"ship_to_address" jsonb
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protection_checks" ADD CONSTRAINT "protection_checks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;