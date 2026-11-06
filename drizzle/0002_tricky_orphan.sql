ALTER TABLE "shipments" ADD COLUMN "push_simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_order_id_unique" ON "shipments" USING btree ("order_id");