/** Marks anything that is not real in the PayPal sandbox (demo carrier, simulated disputes, dev fixtures). */
export default function SimulatedTag({ title = "Not real in the PayPal sandbox: produced by the demo" }: { title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded border border-dashed border-violet-400/70 bg-violet-50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-violet-800"
    >
      Simulated
    </span>
  );
}
