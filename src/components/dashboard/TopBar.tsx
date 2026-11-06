import Link from "next/link";
import type { AiBudget } from "@/lib/ai/budget";
import AiBudgetPill from "./AiBudgetPill";
import Icon from "./Icon";
import NavLinks from "./NavLinks";

/** Slim dashboard bar: wordmark, whose shop this is, navigation and today's AI budget. No login (judges self-serve). */
export default function TopBar({ budget, openDisputes }: { budget: AiBudget | null; openDisputes: number | null }) {
  return (
    <header className="sticky top-0 z-30 bg-green text-white shadow-[0_1px_0_rgba(0,0,0,0.15)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2" aria-label="Seller Shield dashboard home">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/12 ring-1 ring-inset ring-white/20">
              <Icon name="shieldCheck" className="h-4.5 w-4.5 text-[#f2c9a8]" />
            </span>
            <span className="font-display text-lg leading-none tracking-tight">Seller Shield</span>
          </Link>
          <span className="hidden h-5 w-px bg-white/20 md:block" aria-hidden />
          <span className="hidden truncate text-xs text-white/70 md:block">Maya&apos;s dashboard · Juniper &amp; Thread (demo)</span>
        </div>
        <div className="order-3 -mx-1 w-full overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:flex-1">
          <NavLinks openDisputes={openDisputes} />
        </div>
        <AiBudgetPill budget={budget} />
      </div>
      <p className="border-t border-white/10 px-4 py-1 text-center text-[11px] text-white/65 md:hidden">
        Maya&apos;s dashboard · Juniper &amp; Thread (demo)
      </p>
    </header>
  );
}
