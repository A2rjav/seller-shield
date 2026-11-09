// Applies the drizzle migrations in ./drizzle to DATABASE_URL, then exits. Runs before `next start` (see package.json),
// so a Render free web service (no pre-deploy command) migrates on boot. Plain Node ESM: no tsx or drizzle-kit needed.
// Idempotent: drizzle records applied migrations in drizzle.__drizzle_migrations (the same table drizzle-kit migrate uses).
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

try {
  process.loadEnvFile(); // local .env, if present (Node 20.12+); hosted runs read real env vars
} catch {
  // no .env file: fine
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  if (process.env.NODE_ENV === "production") {
    console.error("[migrate] DATABASE_URL is not set; refusing to start without a database.");
    process.exit(1);
  }
  console.info("[migrate] DATABASE_URL is empty: skipped (the local dev database migrates itself).");
  process.exit(0);
}

const folder = path.join(process.cwd(), "drizzle");
for (let attempt = 1; ; attempt++) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 30 });
  try {
    const t = Date.now();
    await migrate(drizzle(sql), { migrationsFolder: folder });
    console.info(`[migrate] migrations up to date (${Date.now() - t} ms).`);
    await sql.end({ timeout: 5 });
    break;
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    const msg = e instanceof Error ? `${e.message.split("\n")[0]}${e.cause instanceof Error ? ` (cause: ${e.cause.message})` : ""}` : String(e);
    if (attempt >= 3) {
      console.error(`[migrate] failed: ${msg}`);
      process.exit(1);
    }
    console.warn(`[migrate] attempt ${attempt} failed (${msg}); retrying in 3s.`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
