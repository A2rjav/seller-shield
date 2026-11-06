"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Orders", match: (p: string) => p === "/dashboard" || p.startsWith("/dashboard/orders") },
  { href: "/dashboard/disputes", label: "Disputes", match: (p: string) => p.startsWith("/dashboard/disputes") },
  { href: "/demo", label: "Demo guide", match: (p: string) => p.startsWith("/demo") },
];

export default function NavLinks({ openDisputes }: { openDisputes: number | null }) {
  const path = usePathname() ?? "";
  return (
    <nav aria-label="Dashboard" className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = l.match(path);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-white/15 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"
            }`}
          >
            {l.label}
            {l.label === "Disputes" && openDisputes ? (
              <span className="rounded-full bg-[#e9a07f] px-1.5 text-[11px] font-semibold leading-4 text-[#3b1607]" aria-label={`${openDisputes} open`}>
                {openDisputes}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
