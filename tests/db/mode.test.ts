import { describe, expect, it } from "vitest";
import { resolveDbMode } from "@/lib/db/mode";

describe("resolveDbMode", () => {
  it("uses Postgres whenever DATABASE_URL is set", () => {
    expect(resolveDbMode({ DATABASE_URL: "postgres://x", NODE_ENV: "development" })).toBe("postgres");
    expect(resolveDbMode({ DATABASE_URL: "postgres://x", NODE_ENV: "production" })).toBe("postgres");
  });
  it("falls back to the local PGlite file outside production", () => {
    expect(resolveDbMode({ DATABASE_URL: "", NODE_ENV: "development" })).toBe("dev-pglite");
    expect(resolveDbMode({ NODE_ENV: "test" })).toBe("dev-pglite");
    expect(resolveDbMode({ DATABASE_URL: "   " })).toBe("dev-pglite");
  });
  it("still requires DATABASE_URL in production", () => {
    expect(resolveDbMode({ DATABASE_URL: "", NODE_ENV: "production" })).toBe("postgres");
  });
});
