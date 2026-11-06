"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { products } from "@/lib/catalog";
import { formatMoney } from "@/lib/format";
import { canonicalJson, signMandate } from "@/lib/mandate/sign";
import type { MandatePayload } from "@/lib/mandate/mandate";

const KEY_STORE = "ss.wallet.key.v1";
const AGENT_ID = "shopper-agent-demo-1";

type Wallet = { priv: CryptoKey; pub: JWK };
type Signed = { jws: string; payload: MandatePayload; hash: string };

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Loads the wallet key from localStorage, or makes a new Ed25519 key (WebCrypto via jose) when missing or unusable. */
async function loadOrCreateKey(): Promise<Wallet> {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    if (raw) {
      const { priv, pub } = JSON.parse(raw) as { priv: JWK; pub: JWK };
      return { priv: (await importJWK(priv, "EdDSA", { extractable: false })) as CryptoKey, pub };
    }
  } catch {
    // fall through: regenerate
  }
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify({ priv, pub }));
  } catch {
    // storage blocked: key lives for this page only
  }
  return { priv: (await importJWK(priv, "EdDSA", { extractable: false })) as CryptoKey, pub };
}

const inputCls = "mt-1 w-full rounded-sm border border-line bg-card px-3 py-2 text-sm";

export const WALLET_EMAIL_HINT =
  "Use the sandbox test buyer you will pay with (shown on /demo), or the PayPal payer email check will flag a mismatch.";

/** The wallet UI. `defaultEmail` is the sandbox test buyer, passed in by the server page. */
export default function WalletClient({ defaultEmail }: { defaultEmail: string }) {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [sku, setSku] = useState(products[0].sku);
  const [maxDollars, setMaxDollars] = useState("60");
  const [hours, setHours] = useState("24");
  const [signedM, setSignedM] = useState<Signed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOrCreateKey()
      .then(setWallet)
      .catch(() => setKeyError("This browser cannot create the Ed25519 signing key the wallet needs. Try a current Chrome, Edge, Firefox or Safari."));
  }, []);

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!wallet) return;
    const cents = Math.round(Number(maxDollars) * 100);
    const h = Number(hours);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError("Enter the email of the PayPal account that will pay.");
    if (!Number.isFinite(cents) || cents <= 0) return setError("Enter a maximum price above zero.");
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) return setError("Expiry must be between 1 hour and 30 days.");
    const now = new Date();
    const payload: MandatePayload = {
      mandateId: crypto.randomUUID(),
      shopperEmail: email.trim(),
      agentId: AGENT_ID,
      merchantId: "juniper-and-thread",
      items: [{ sku, qty: 1 }],
      maxAmountCents: cents,
      currency: "USD",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + h * 3600_000).toISOString(),
      shopperPublicJwk: wallet.pub as JsonWebKey,
    };
    try {
      const jws = await signMandate(payload, wallet.priv);
      setSignedM({ jws, payload, hash: await sha256Hex(canonicalJson(payload)) });
    } catch {
      setError("Signing failed in this browser.");
    }
  }

  function give() {
    if (!signedM) return;
    try {
      sessionStorage.setItem("ss.mandate.jws", signedM.jws);
    } catch {
      setError("This browser blocked session storage, so the mandate cannot be handed over.");
      return;
    }
    router.push("/agent");
  }

  const product = products.find((p) => p.sku === sku);
  return (
    <div>
      <h1 className="font-display text-3xl text-green">Your wallet</h1>
      <p className="mt-3 leading-relaxed text-muted">
        Sign a purchase mandate: what your AI assistant may buy, for how much, and until when. It is signed in this browser with a
        key that never leaves it. The store checks the signature before anything is bought, and you still approve the payment in PayPal.
      </p>
      {keyError && <p role="alert" className="mt-4 rounded-sm border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-dark">{keyError}</p>}

      <form onSubmit={sign} className="mt-8 grid gap-5 rounded-sm border border-line bg-card p-5 sm:grid-cols-2">
        <label className="text-sm sm:col-span-2">
          Your PayPal email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="the PayPal account that will pay" aria-describedby="wallet-email-hint" className={inputCls} />
          <span id="wallet-email-hint" className="mt-1 block text-xs text-muted">{WALLET_EMAIL_HINT}</span>
        </label>
        <label className="text-sm">
          What may it buy
          <select value={sku} onChange={(e) => setSku(e.target.value)} className={inputCls}>
            {products.map((p) => (
              <option key={p.sku} value={p.sku}>{p.name} ({formatMoney(p.priceCents)})</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Maximum price (USD)
          <input inputMode="decimal" value={maxDollars} onChange={(e) => setMaxDollars(e.target.value)} className={inputCls} />
        </label>
        <label className="text-sm">
          Valid for (hours)
          <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} className={inputCls} />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={!wallet} className="rounded-sm bg-green px-5 py-2 text-sm text-card disabled:opacity-50">
            Sign mandate
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-accent-dark sm:col-span-2">{error}</p>}
      </form>

      {signedM && (
        <section className="mt-8 rounded-sm border border-green/40 bg-card p-5" aria-label="Signed mandate">
          <h2 className="font-display text-xl text-green">Mandate signed</h2>
          <ul className="mt-3 space-y-1 text-sm">
            <li>Your assistant may buy: <strong>{product?.name}</strong> (1 piece) from Juniper &amp; Thread.</li>
            <li>It may spend at most <strong>{formatMoney(signedM.payload.maxAmountCents)}</strong>.</li>
            <li>Valid until <strong>{new Date(signedM.payload.expiresAt).toLocaleString()}</strong>, and it works once.</li>
            <li>Payment still needs your approval in PayPal ({signedM.payload.shopperEmail}).</li>
          </ul>
          <p className="mt-3 break-all text-xs text-muted">Mandate fingerprint (SHA-256): {signedM.hash}</p>
          <button onClick={give} className="mt-5 rounded-sm bg-accent px-5 py-2 text-sm text-card hover:bg-accent-dark">
            Give this to my AI assistant
          </button>
        </section>
      )}
    </div>
  );
}
