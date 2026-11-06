"use client";

import { useState } from "react";
import PayPalButton from "./PayPalButton";
import { formatMoney } from "@/lib/format";

export default function ProductBuy({ sku, priceCents, clientId }: { sku: string; priceCents: number; clientId: string | null }) {
  const [qty, setQty] = useState(1);
  return (
    <div>
      <div className="flex items-center gap-4">
        <label htmlFor="qty" className="text-sm text-muted">
          Quantity
        </label>
        <select
          id="qty"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="rounded-sm border border-line bg-card px-3 py-2 text-sm"
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="ml-auto font-display text-xl text-green">{formatMoney(priceCents * qty)}</span>
      </div>
      <div className="mt-5">
        {clientId ? (
          <PayPalButton clientId={clientId} items={[{ sku, qty }]} />
        ) : (
          <p role="alert" className="rounded-sm border border-line bg-card px-3 py-2 text-sm text-muted">
            Checkout is not available right now.
          </p>
        )}
      </div>
    </div>
  );
}
