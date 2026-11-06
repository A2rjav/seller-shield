/** Money is integer cents internally; PayPal decimal strings only at the API edge. */
export function toCents(v: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid money amount: "${v}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

export function toPaypalAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
