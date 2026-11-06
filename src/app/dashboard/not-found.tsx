import Link from "next/link";
import EmptyState from "@/components/dashboard/EmptyState";
import Panel from "@/components/dashboard/Panel";

export default function DashboardNotFound() {
  return (
    <Panel className="mx-auto max-w-xl">
      <EmptyState
        icon="search"
        title="We could not find that record"
        action={
          <Link href="/dashboard" className="rounded-lg bg-green px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#243a2b]">
            Back to orders
          </Link>
        }
      >
        It may have been removed when the demo was reset.
      </EmptyState>
    </Panel>
  );
}
