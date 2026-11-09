// Prints a short summary of the demo rows in the configured database (no emails, no secrets).
// Run: npx tsx scripts/db-status.ts
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/lib/db/client";

async function main() {
  const db = getDb();
  const counts = await db.execute(sql`select
    (select count(*) from orders) as orders, (select count(*) from shipments) as shipments,
    (select count(*) from disputes) as disputes, (select count(*) from mandates) as mandates,
    (select count(*) from cases) as cases, (select count(*) from protection_checks) as protection_checks`);
  console.log("counts", JSON.stringify(Array.from(counts as unknown as Iterable<unknown>)[0]));
  const rows = await db.execute(sql`select o.id, o.source, o.status, o.amount_cents, o.capture_id is not null as captured,
      o.mandate_id is not null as has_mandate, pc.result->>'status' as protection, s.carrier, s.status as ship_status,
      s.pushed_to_paypal as pushed, s.simulated as ship_sim, d.id as dispute_id, d.status as dispute_status, d.simulated as dispute_sim
    from orders o left join protection_checks pc on pc.order_id = o.id left join shipments s on s.order_id = o.id
    left join disputes d on d.order_id = o.id order by o.created_at`);
  console.table(Array.from(rows as unknown as Iterable<Record<string, unknown>>));
  const m = await db.execute(sql`select id, order_id, verified, payer_email_match, paypal_custom_id_match, failures from mandates order by created_at desc limit 5`);
  console.table(Array.from(m as unknown as Iterable<Record<string, unknown>>));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
