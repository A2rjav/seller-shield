import Link from "next/link";

export default function ShopperLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-baseline justify-between gap-4 px-5 py-5">
          <Link href="/" className="whitespace-nowrap font-display text-xl tracking-tight text-green sm:text-2xl">
            Juniper <span className="text-accent">&amp;</span> Thread
          </Link>
          <nav className="flex gap-4 text-xs uppercase tracking-[0.14em] text-muted sm:gap-5 sm:tracking-[0.18em]">
            <Link href="/wallet" className="hover:text-accent">Wallet</Link>
            <Link href="/agent" className="hover:text-accent">Assistant</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
        <p className="mb-8 rounded-sm border border-line bg-card px-3 py-2 text-xs text-muted">
          This is the shopper&apos;s side: your AI shopping assistant — demo. It buys from the store through an agent checkout, within a limit you sign.
        </p>
        {children}
      </main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-3xl px-5 py-6 text-xs text-muted">Demo for the PayPal AI Hackathon — sandbox payments only.</p>
      </footer>
    </div>
  );
}
