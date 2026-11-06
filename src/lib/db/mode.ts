export type DbMode = "postgres" | "dev-pglite";

/**
 * Postgres whenever DATABASE_URL is set. Outside production an empty DATABASE_URL falls back to a local
 * file-backed PGlite database (dev only). Production always uses Postgres, so a missing URL fails loudly there.
 */
export function resolveDbMode(env: Record<string, string | undefined>): DbMode {
  if (env.DATABASE_URL?.trim()) return "postgres";
  return env.NODE_ENV === "production" ? "postgres" : "dev-pglite";
}
