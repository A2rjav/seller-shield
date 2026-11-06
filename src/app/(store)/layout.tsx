import Link from "next/link";

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between gap-4 px-5 py-5">
          <Link href="/" className="whitespace-nowrap font-display text-2xl tracking-tight text-green">
            Juniper <span className="text-accent">&amp;</span> Thread
          </Link>
          <span className="hidden whitespace-nowrap text-xs uppercase tracking-[0.18em] text-muted sm:inline">Handmade in Portland</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 sm:py-14">{children}</main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-5xl px-5 py-6 text-xs text-muted">
          Demo store for the PayPal AI Hackathon — sandbox payments only.
        </p>
      </footer>
    </div>
  );
}
