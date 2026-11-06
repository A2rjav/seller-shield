import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import { getDevDb } from "./dev-pglite";
import { resolveDbMode } from "./mode";
import * as schema from "./schema";

/** Satisfied by both the postgres-js (Neon) and PGlite (tests) Drizzle instances. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let instance: Db | undefined;

/**
 * Lazily connects on first use; never reads DATABASE_URL at import time.
 * Dev only: an empty DATABASE_URL outside production uses the local PGlite file at `.data/pglite`.
 */
export function getDb(): Db {
  if (!instance) {
    if (resolveDbMode(process.env) === "dev-pglite") {
      instance = getDevDb() as unknown as Db;
    } else {
      const client = postgres(getEnv().DATABASE_URL, { max: 5, prepare: false });
      instance = drizzle(client, { schema }) as unknown as Db;
    }
  }
  return instance;
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
