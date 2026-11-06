import { describe, expect, it } from "vitest";
import { kitDatabaseUrl } from "@/lib/db/kit-url";

describe("kitDatabaseUrl (M7)", () => {
  it("generate works without DATABASE_URL", () => {
    expect(kitDatabaseUrl(["node", "drizzle-kit", "generate"], {})).toBe("");
  });
  it("migrate with an empty DATABASE_URL fails with a clear message", () => {
    expect(() => kitDatabaseUrl(["node", "drizzle-kit", "migrate"], { DATABASE_URL: " " })).toThrow(
      /DATABASE_URL is empty.*drizzle-kit migrate.*generate does not need it/,
    );
    expect(() => kitDatabaseUrl(["node", "drizzle-kit", "push"], {})).toThrow(/DATABASE_URL is empty/);
  });
  it("passes a set URL through", () => {
    expect(kitDatabaseUrl(["node", "drizzle-kit", "migrate"], { DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });
});
