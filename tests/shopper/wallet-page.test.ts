import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// The client component is never rendered here; keep Next's router (a large module graph) out of the worker.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
import WalletPage, { dynamic } from "@/app/(shopper)/wallet/page";
import WalletClient, { WALLET_EMAIL_HINT } from "@/app/(shopper)/wallet/WalletClient";

describe("wallet page server wrapper (I6)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("pre-fills the shopper email with SANDBOX_BUYER_EMAIL, read per request", () => {
    vi.stubEnv("SANDBOX_BUYER_EMAIL", "sb-buyer@personal.example.com");
    const el = WalletPage();
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe(WalletClient);
    expect((el.props as { defaultEmail: string }).defaultEmail).toBe("sb-buyer@personal.example.com");
    expect(dynamic).toBe("force-dynamic");
  });

  it("passes an empty email when the sandbox buyer is not configured", () => {
    vi.stubEnv("SANDBOX_BUYER_EMAIL", "");
    expect((WalletPage().props as { defaultEmail: string }).defaultEmail).toBe("");
  });

  it("states the hint about the sandbox buyer and the payer email check", () => {
    expect(WALLET_EMAIL_HINT).toBe(
      "Use the sandbox test buyer you will pay with (shown on /demo), or the PayPal payer email check will flag a mismatch.",
    );
  });
});
