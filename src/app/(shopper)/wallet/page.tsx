import { getSandboxBuyerEmail } from "@/lib/env";
import WalletClient from "./WalletClient";

// Read the sandbox buyer per request (Render env), never baked in at build time.
export const dynamic = "force-dynamic";

/** Server wrapper: pre-fills the shopper email with the shared sandbox test buyer the judge will pay with. */
export default function WalletPage() {
  return <WalletClient defaultEmail={getSandboxBuyerEmail() ?? ""} />;
}
