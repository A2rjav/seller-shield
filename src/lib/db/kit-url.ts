// Used by drizzle.config.ts (drizzle-kit) only. No path aliases here: drizzle-kit loads it directly.

const NEEDS_DB = ["migrate", "push", "pull", "introspect", "studio", "check", "up", "drop"];

/** DATABASE_URL for drizzle-kit: `generate` works without it; commands that connect fail with a clear message. */
export function kitDatabaseUrl(argv: string[], env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL?.trim() ?? "";
  const command = argv.find((a) => NEEDS_DB.includes(a));
  if (!url && command) {
    throw new Error(
      `DATABASE_URL is empty: set it in seller-shield/.env to run drizzle-kit ${command} (generate does not need it).`,
    );
  }
  return url;
}
