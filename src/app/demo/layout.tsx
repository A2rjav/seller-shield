import type { Metadata } from "next";
import TopBar from "@/components/dashboard/TopBar";
import { aiBudget } from "@/lib/ai/budget";
import { countOpenDisputes } from "@/lib/dashboard/queries";
import { db } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "Seller Shield - Demo guide",
  description: "A guided tour of Seller Shield for judges: buy, let an AI agent buy, open a dispute, defend it, resolve it.",
};

export const dynamic = "force-dynamic";

export default async function DemoLayout({ children }: { children: React.ReactNode }) {
  const [budget, openDisputes] = await Promise.all([aiBudget(db).catch(() => null), countOpenDisputes(db).catch(() => null)]);
  return (
    <div className="app-shell flex min-h-screen flex-col">
      <TopBar budget={budget} openDisputes={openDisputes} />
      <main className="mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="mx-auto w-full max-w-4xl px-4 pb-8 text-xs text-muted sm:px-6">
        PayPal sandbox only: no real money moves. Items tagged Simulated are produced by the demo, not by PayPal.
      </footer>
    </div>
  );
}
