import { describe, it, expect } from "vitest";
import { getDatabaseUrl, getEnv, getSandboxBuyerEmail } from "@/lib/env";

describe("env", () => {
  it("lists missing keys without leaking values", () => {
    expect(() => getEnv({ PAYPAL_CLIENT_SECRET: "s3cret" })).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => getEnv({ PAYPAL_CLIENT_SECRET: "s3cret" })).not.toThrow(/s3cret/);
  });
  it("applies defaults and treats empty strings as unset", () => {
    const e = getEnv({
      PAYPAL_CLIENT_ID: "a",
      PAYPAL_CLIENT_SECRET: "b",
      SANDBOX_BUYER_EMAIL: "c",
      SANDBOX_BUYER_PASSWORD: "d",
      GEMINI_API_KEY: "e",
      DATABASE_URL: "postgres://x",
      GEMINI_MODEL: "",
      AI_DAILY_CALL_LIMIT: "",
    });
    expect(e.AI_DAILY_CALL_LIMIT).toBe(300);
    expect(e.GEMINI_MODEL).toBeUndefined();
    expect(e.PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });
});

describe("getDatabaseUrl (M4)", () => {
  it("needs only DATABASE_URL: a missing Gemini or buyer key never takes the DB down", () => {
    expect(getDatabaseUrl({ DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });
  it("names only DATABASE_URL when it is missing or blank", () => {
    expect(() => getDatabaseUrl({ DATABASE_URL: "  " })).toThrow(/^Invalid or missing environment variables: DATABASE_URL$/);
  });
});

describe("getSandboxBuyerEmail (I6)", () => {
  it("returns the trimmed sandbox buyer email, or undefined when unset", () => {
    expect(getSandboxBuyerEmail({ SANDBOX_BUYER_EMAIL: " buyer@example.com " })).toBe("buyer@example.com");
    expect(getSandboxBuyerEmail({ SANDBOX_BUYER_EMAIL: "" })).toBeUndefined();
    expect(getSandboxBuyerEmail({})).toBeUndefined();
  });
});
