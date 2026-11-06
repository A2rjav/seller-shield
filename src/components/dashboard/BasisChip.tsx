import type { Gap } from "@/lib/protection/rules";
import { basisLabel } from "@/lib/dashboard/view";

/** Says whether a gap is a stated PayPal Seller Protection requirement or Seller Shield's own best practice. */
export default function BasisChip({ basis }: { basis: Gap["basis"] }) {
  const policy = basis === "paypal_policy";
  return (
    <span
      title={policy ? "A requirement in PayPal's US Seller Protection policy" : "Seller Shield best practice, not a stated PayPal rule"}
      className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${
        policy ? "bg-[#e8eef9] text-[#1d3f7a]" : "bg-[#eaf1ec] text-green"
      }`}
    >
      {basisLabel(basis)}
    </span>
  );
}
