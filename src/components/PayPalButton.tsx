"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { sku: string; qty: number };

type PayPalNamespace = {
  Buttons: (opts: {
    style?: Record<string, unknown>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onError: (err: unknown) => void;
    onCancel?: () => void;
  }) => { render: (el: HTMLElement) => Promise<void>; close: () => Promise<void> };
};
declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

let sdkPromise: Promise<PayPalNamespace> | undefined;

/** Loads the PayPal JS SDK once per page load. */
function loadSdk(clientId: string): Promise<PayPalNamespace> {
  if (window.paypal) return Promise.resolve(window.paypal);
  sdkPromise ??= new Promise<PayPalNamespace>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    s.async = true;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK missing")));
    s.onerror = () => {
      sdkPromise = undefined;
      reject(new Error("Could not load PayPal"));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/** With `orderId` the order already exists (agent checkout): the button only approves and captures it. */
export default function PayPalButton({ clientId, items = [], orderId }: { clientId: string; items?: Item[]; orderId?: string }) {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const itemsKey = JSON.stringify(items);

  useEffect(() => {
    itemsRef.current = items;
  });

  useEffect(() => {
    let cancelled = false;
    let buttons: { close: () => Promise<void> } | undefined;
    loadSdk(clientId)
      .then((paypal) => {
        if (cancelled || !container.current) return;
        const b = paypal.Buttons({
          style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal" },
          createOrder: async () => {
            setError(null);
            if (orderId) return orderId;
            const r = await postJson("/api/orders", { items: itemsRef.current });
            if (!r.ok || typeof r.data.id !== "string") throw new Error(String(r.data.error ?? "Could not start checkout"));
            return r.data.id;
          },
          onApprove: async ({ orderID }) => {
            const r = await postJson(`/api/orders/${encodeURIComponent(orderID)}/capture`, {});
            if (!r.ok) {
              setError("Your payment could not be completed. Please try again.");
              return;
            }
            router.push(`/order/${encodeURIComponent(orderID)}`);
          },
          onError: () => setError("Something went wrong with PayPal. Please try again in a moment."),
          onCancel: () => setError(null),
        });
        buttons = b;
        container.current.innerHTML = "";
        b.render(container.current)
          .then(() => !cancelled && setReady(true))
          .catch(() => !cancelled && setError("PayPal buttons could not be shown."));
      })
      .catch(() => !cancelled && setError("PayPal could not be loaded. Check your connection and refresh."));
    return () => {
      cancelled = true;
      buttons?.close().catch(() => {});
    };
  }, [clientId, itemsKey, orderId, router]);

  return (
    <div>
      <div ref={container} aria-busy={!ready} className="min-h-[45px]" />
      {error && (
        <p role="alert" className="mt-3 rounded-sm border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-dark">
          {error}
        </p>
      )}
    </div>
  );
}
