import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/env";
import { getDevDb } from "./dev-pglite";
import { resolveDbMode } from "./mode";
import * as schema from "./schema";

/** Satisfied by both the postgres-js (Neon) and PGlite (tests) Drizzle instances. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let instance: Db | undefined;
let pgClient: ReturnType<typeof postgres> | undefined;

/**
 * Lazily connects on first use; never reads DATABASE_URL at import time.
 * Dev only: an empty DATABASE_URL outside production uses the local PGlite file at `.data/pglite`.
 */
export function getDb(): Db {
  if (!instance) {
    if (resolveDbMode(process.env) === "dev-pglite") {
      instance = getDevDb() as unknown as Db;
    } else {
      // idle_timeout lets idle sockets close (Neon drops them anyway), so short scripts and serverless-style idling do not hold stale connections.
      pgClient = postgres(getDatabaseUrl(), { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 30 });
      instance = drizzle(pgClient, { schema }) as unknown as Db;
    }
  }
  return instance;
}

/** Ends the postgres-js pool (scripts call this so Node can exit). Dev PGlite is closed with closeDevDb(). */
export async function closeDb(): Promise<void> {
  const c = pgClient;
  pgClient = undefined;
  instance = undefined;
  if (c) await c.end({ timeout: 5 });
}

/** Lazy proxy so `import { db }` is safe without DATABASE_URL. */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export { schema };
