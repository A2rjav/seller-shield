"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import PayPalButton from "@/components/PayPalButton";
import { formatMoney } from "@/lib/format";
import type { AgentEvent } from "@/lib/agent/shopper-agent";

type Msg = { role: "user" | "assistant"; content: string; events?: AgentEvent[] };

const REFUSAL_COPY: Record<string, string> = {
  bad_shopper_signature: "The mandate signature did not check out, so it may have been altered.",
  bad_agent_signature: "The assistant's signed request did not match this order.",
  agent_not_named: "This assistant is not the one named in your mandate.",
  expired: "Your mandate has expired. Sign a new one in your wallet.",
  amount_over_max: "The total is over the maximum you set.",
  item_not_in_mandate: "That item (or quantity) is not in what you allowed.",
  currency_mismatch: "The currency does not match your mandate.",
  malformed_mandate: "The mandate could not be read.",
  invalid_order: "The order was not valid.",
  payer_email_mismatch: "The PayPal account paying is not the one in your mandate.",
};

function Card({ ev, clientId }: { ev: AgentEvent; clientId: string | null }) {
  if (ev.type === "refused") {
    return (
      <div role="alert" className="rounded-sm border border-accent/40 bg-accent/10 p-4 text-sm text-accent-dark">
        <p className="font-medium">The store refused this purchase.</p>
        {ev.reason && <p className="mt-1">{ev.reason === "mandate already used" ? "This mandate was already used. Sign a new one in your wallet." : ev.reason}</p>}
        {ev.failures.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {ev.failures.map((f) => (
              <li key={f}>{REFUSAL_COPY[f] ?? f}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-green/40 bg-card p-4 text-sm">
      <p className="font-medium text-green">Order ready: {formatMoney(ev.totalCents)}</p>
      <p className="mt-1 text-muted">{ev.items.map((i) => `${i.qty} x ${i.name}`).join(", ")}</p>
      <p className="mt-1 break-all text-xs text-muted">Bound to your mandate {ev.hash.slice(0, 16)}...</p>
      <p className="mt-3">Your assistant cannot pay for you. Approve the payment in PayPal:</p>
      <div className="mt-3 max-w-xs">
        {clientId ? (
          <PayPalButton clientId={clientId} orderId={ev.orderId} />
        ) : (
          <a href={ev.approveUrl} target="_blank" rel="noreferrer" className="inline-block rounded-sm bg-accent px-4 py-2 text-card">
            Approve in PayPal
          </a>
        )}
      </div>
    </div>
  );
}

export default function AgentChat({ clientId }: { clientId: string | null }) {
  const [jws, setJws] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiDown, setAiDown] = useState(false);

  useEffect(() => {
    try {
      setJws(sessionStorage.getItem("ss.mandate.jws"));
    } catch {
      setJws(null);
    }
    setReady(true);
  }, []);

  async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch("/api/agent/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ error: "Something went wrong." }))) as Record<string, unknown>;
  }

  function apply(r: Record<string, unknown>, history: Msg[]) {
    if (r.aiUnavailable) {
      setAiDown(true);
      setMsgs([...history, { role: "assistant", content: "The AI assistant is unavailable right now (the demo's daily AI limit may be reached). You can still finish with the button below." }]);
    } else if (typeof r.error === "string") {
      setMsgs([...history, { role: "assistant", content: r.error }]);
    } else {
      const events = (r.events as AgentEvent[] | undefined) ?? [];
      const text = typeof r.text === "string" && r.text ? r.text : events.length ? "" : "Done.";
      setMsgs([...history, { role: "assistant", content: text, events }]);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !jws || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(history);
    setInput("");
    setBusy(true);
    const r = await call({ shopperJws: jws, messages: history.map(({ role, content }) => ({ role, content: content || "(checkout started)" })) });
    apply(r, history);
    setBusy(false);
  }

  async function runWithoutAi() {
    if (!jws || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: "Buy exactly what my mandate allows (no AI)." }];
    setMsgs(history);
    setBusy(true);
    apply(await call({ shopperJws: jws, mode: "deterministic" }), history);
    setBusy(false);
  }

  if (!ready) return null;
  if (!jws) {
    return (
      <div>
        <h1 className="font-display text-3xl text-green">Your AI shopping assistant</h1>
        <p className="mt-4 text-muted">
          It needs a signed mandate first. <Link href="/wallet" className="text-accent underline">Sign one in your wallet</Link>, then hand it over.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-display text-3xl text-green">Your AI shopping assistant</h1>
      <p className="mt-3 text-muted">
        Try: &ldquo;buy the hoops&rdquo;. It can only act inside the mandate you signed. <Link href="/wallet" className="text-accent underline">Change mandate</Link>
      </p>
      <div className="mt-6 space-y-4" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "ml-10 rounded-sm bg-green/10 px-4 py-3 text-sm" : "mr-10 space-y-3"}>
            {m.content && <p className={m.role === "assistant" ? "rounded-sm border border-line bg-card px-4 py-3 text-sm" : ""}>{m.content}</p>}
            {m.events?.map((ev, j) => <Card key={j} ev={ev} clientId={clientId} />)}
          </div>
        ))}
        {busy && <p className="text-sm text-muted">Thinking...</p>}
      </div>
      <form onSubmit={send} className="mt-6 flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask your assistant to buy something"
          maxLength={500}
          className="flex-1 rounded-sm border border-line bg-card px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-sm bg-green px-5 py-2 text-sm text-card disabled:opacity-50">
          Send
        </button>
      </form>
      <div className="mt-4">
        <button onClick={runWithoutAi} disabled={busy} className={`rounded-sm border px-4 py-2 text-sm ${aiDown ? "border-accent bg-accent text-card" : "border-line text-muted hover:text-accent"}`}>
          Run without AI
        </button>
        <span className="ml-3 text-xs text-muted">Buys exactly what your mandate allows, through the same signed checkout.</span>
      </div>
    </div>
  );
}
