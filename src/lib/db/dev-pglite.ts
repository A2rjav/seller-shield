import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";

/*
 * DEV ONLY. When DATABASE_URL is empty outside production, the app runs on a file-backed PGlite database at
 * `.data/pglite` (git-ignored) with the drizzle migrations applied on first use. Production never reaches this.
 * One instance per process (kept on globalThis): Next dev can load this module in several bundles, and two
 * PGlite instances on one data directory would corrupt it.
 */

type Client = Pick<PGlite, "query" | "exec" | "transaction">;
type DevDb = ReturnType<typeof drizzle<typeof schema>>;

const KEY = Symbol.for("seller-shield.dev-pglite");
const holder = globalThis as unknown as Record<symbol, { db: DevDb; ready: Promise<PGlite> } | undefined>;

export const DEV_DATA_DIR = path.join(process.cwd(), ".data", "pglite");

function open(): { db: DevDb; ready: Promise<PGlite> } {
  const ready = (async () => {
    mkdirSync(DEV_DATA_DIR, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(DEV_DATA_DIR);
    await migrate(drizzle({ client, schema }), { migrationsFolder: path.join(process.cwd(), "drizzle") });
    console.info("[db] DATABASE_URL is empty: using the local dev database at .data/pglite (dev only, never production).");
    return client;
  })();
  // Every query waits until the migrations have run, so getDb() can stay synchronous.
  const gated: Client = {
    query: (async (...args: Parameters<PGlite["query"]>) => (await ready).query(...args)) as PGlite["query"],
    exec: (async (...args: Parameters<PGlite["exec"]>) => (await ready).exec(...args)) as PGlite["exec"],
    transaction: (async (...args: Parameters<PGlite["transaction"]>) => (await ready).transaction(...args)) as PGlite["transaction"],
  };
  return { db: drizzle({ client: gated as PGlite, schema }), ready };
}

export function getDevDb(): DevDb {
  holder[KEY] ??= open();
  return holder[KEY].db;
}

/** Closes the dev database (scripts call this so the process can exit and the files are flushed). */
export async function closeDevDb(): Promise<void> {
  const h = holder[KEY];
  if (!h) return;
  holder[KEY] = undefined;
  await (await h.ready).close();
}
