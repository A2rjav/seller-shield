import { describe, it, expect } from "vitest";
import { getEnv } from "@/lib/env";

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
