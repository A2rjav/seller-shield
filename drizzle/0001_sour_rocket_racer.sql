ALTER TABLE "cases" ADD COLUMN "built_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "action_in_flight_at" timestamp with time zone;