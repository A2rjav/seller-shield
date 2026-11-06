import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { messages, orders } from "@/lib/db/schema";
import { formatMoney } from "@/lib/format";
import { statusCopy } from "@/lib/orders/status-copy";
import type { OrderItem } from "@/lib/orders/record";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) notFound();
  const thread = await db.select().from(messages).where(eq(messages.orderId, id)).orderBy(asc(messages.createdAt));

  const items = order.items as OrderItem[];
  const addr = order.shipAddress as { city?: string; state?: string } | null;
  const copy = statusCopy(order.status);
  const firstSku = items[0]?.sku;

  return (
    <div className="max-w-2xl">
      <p className="text-xs uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl text-green sm:text-4xl">
        {copy.headline}
      </h1>
      {copy.detail && (
        <p role="alert" className="mt-3 text-muted">
          {copy.detail}{" "}
          <Link href={firstSku ? `/product/${firstSku}` : "/"} className="text-accent underline">
            Back to the product
          </Link>
        </p>
      )}
      <p className="mt-3 text-sm text-muted">
        Order <span className="font-mono">{order.id}</span> &middot; Status{" "}
        <span className="rounded-sm border border-line bg-card px-2 py-0.5 font-medium text-foreground">{order.status}</span>
      </p>

      <section className="mt-8 rounded-sm border border-line bg-card p-5" aria-label="Order summary">
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.sku} className="flex items-baseline justify-between gap-4 py-3">
              <span>
                {i.name} <span className="text-muted">&times; {i.qty}</span>
              </span>
              <span>{formatMoney(i.priceCents * i.qty, order.currency)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex justify-between border-t border-line pt-3 font-medium">
          <span>Total</span>
          <span>{formatMoney(order.amountCents, order.currency)}</span>
        </p>
        {addr?.city && (
          <p className="mt-4 text-sm text-muted">
            Shipping to {addr.city}, {addr.state}. Tracking will be sent once it is posted.
          </p>
        )}
      </section>

      <section className="mt-10" aria-label="Message the seller">
        <h2 className="font-display text-xl text-green">Message Maya</h2>
        {thread.length > 0 && (
          <ul className="mt-4 space-y-3">
            {thread.map((m) => (
              <li key={m.id} className={`rounded-sm border border-line p-3 text-sm ${m.author === "buyer" ? "bg-card" : "bg-background"}`}>
                <p className="mb-1 text-xs uppercase tracking-wider text-muted">
                  {m.author === "buyer" ? "You" : m.author === "seller" ? "Maya" : "PayPal"} &middot;{" "}
                  {m.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action={`/api/orders/${encodeURIComponent(order.id)}/messages`} className="mt-4">
          <label htmlFor="body" className="sr-only">
            Your message
          </label>
          <textarea
            id="body"
            name="body"
            required
            maxLength={2000}
            rows={4}
            placeholder="Questions about your order, sizing, or delivery?"
            className="w-full rounded-sm border border-line bg-card p-3 text-sm focus:border-green focus:outline-none"
          />
          <button type="submit" className="mt-3 rounded-sm bg-green px-5 py-2.5 text-sm font-medium text-background hover:bg-accent">
            Send message
          </button>
        </form>
      </section>

      <Link href="/" className="mt-10 inline-block text-sm text-muted hover:text-accent">
        &larr; Back to the shop
      </Link>
    </div>
  );
}
