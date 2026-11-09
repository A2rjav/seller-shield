// Seeds the demo from the real sandbox orders listed in scripts/baseline-orders.json.
// Run: npm run seed   (needs a real DATABASE_URL and PayPal sandbox keys in .env; idempotent)
// With DATABASE_URL empty it refuses, unless you pass --dev to seed the local dev PGlite database on purpose.
import "dotenv/config";
import { closeDb, getDb } from "../src/lib/db/client";
import { closeDevDb } from "../src/lib/db/dev-pglite";
import { loadBaseline } from "../src/lib/demo/baseline";
import { seedDemo, seedModeError } from "../src/lib/demo/seed";
import { getOrder } from "../src/lib/paypal/orders";

async function main() {
  const dev = process.argv.includes("--dev");
  const blocked = seedModeError(process.env, dev);
  if (blocked) {
    console.error(blocked);
    process.exit(1);
  }
  const entries = loadBaseline();
  if (entries.length === 0) console.warn("scripts/baseline-orders.json is empty: nothing to seed.");
  const r = await seedDemo(getDb(), { getOrder, entries });
  console.log(`Seeded ${r.seeded} of ${entries.length} baseline orders.`);
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  if (dev) await closeDevDb();
  else await closeDb();
  if (r.failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDevDb().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
