import type { Metadata } from "next";
import TopBar from "@/components/dashboard/TopBar";
import { aiBudget } from "@/lib/ai/budget";
import { db } from "@/lib/db/client";
import { countOpenDisputes } from "@/lib/dashboard/queries";

export const metadata: Metadata = {
  title: "Seller Shield - Maya's dashboard",
  description: "Prevent, prove and defend PayPal disputes for Juniper & Thread (demo).",
};

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [budget, openDisputes] = await Promise.all([aiBudget(db).catch(() => null), countOpenDisputes(db).catch(() => null)]);
  return (
    <div className="app-shell flex min-h-screen flex-col">
      <TopBar budget={budget} openDisputes={openDisputes} />
      <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="mx-auto w-full max-w-7xl px-4 pb-8 text-xs text-muted sm:px-6">
        PayPal sandbox only. Win chances and expected values are estimates, not PayPal outcomes. Items tagged Simulated are produced by the demo.
      </footer>
    </div>
  );
}
