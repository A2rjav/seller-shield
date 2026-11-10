import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getGeminiModel, isOverloaded, modelIdOf, noteModelFailure, OVERLOAD_RETRY_MS, TOOL_LOOP_OPTIONS, tryConsumeAiCall } from "@/lib/ai/gemini";
import { getProduct, products } from "@/lib/catalog";
import type { Db } from "@/lib/db/client";
import { formatMoney } from "@/lib/format";
import { canonicalHash, signAgentRequest, type MandateFailure, type MandatePayload } from "@/lib/mandate/mandate";
import { getAgentKeys } from "./agent-keys";
import { agentCheckout, buildOrderRequest, type CheckoutDeps } from "./checkout";

export const MAX_SHOPPER_STEPS = 4;

export type AgentEvent =
  | { type: "checkout"; orderId: string; approveUrl: string; totalCents: number; hash: string; items: { sku: string; name: string; qty: number }[] }
  | { type: "refused"; failures: MandateFailure[]; reason?: string };

export type AgentSigner = { agentId: string; privateKey: CryptoKey };
export type AgentDeps = {
  checkoutDeps?: CheckoutDeps;
  agentSigner?: AgentSigner;
};
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatResult = { aiUnavailable: true } | { error: string } | { text: string; events: AgentEvent[] };

/** Reads the mandate payload WITHOUT verifying it. Verification happens at the merchant checkout. */
export function decodeMandate(shopperJws: string): MandatePayload | null {
  try {
    const part = shopperJws.split(".")[1];
    if (!part) return null;
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as MandatePayload;
    if (!p || typeof p.mandateId !== "string" || !Array.isArray(p.items) || typeof p.maxAmountCents !== "number") return null;
    return p;
  } catch {
    return null;
  }
}

function describeItems(items: { sku: string; qty: number }[]): string {
  return items.map((i) => `${i.qty} x ${getProduct(i.sku)?.name ?? i.sku} (${i.sku})`).join(", ");
}

export function mandateSummary(p: MandatePayload): string {
  return `Items: ${describeItems(p.items)}. Maximum total: ${formatMoney(p.maxAmountCents, p.currency)}. Expires: ${p.expiresAt}.`;
}

async function signer(deps: AgentDeps): Promise<AgentSigner> {
  if (deps.agentSigner) return deps.agentSigner;
  const k = await getAgentKeys();
  return { agentId: k.agentId, privateKey: k.privateKey };
}

/** Signs the order with the agent key (the model never sees or chooses the mandate) and calls the merchant checkout. */
export async function agentSignedCheckout(db: Db, shopperJws: string, items: unknown, deps: AgentDeps = {}): Promise<AgentEvent> {
  const payload = decodeMandate(shopperJws);
  if (!payload) return { type: "refused", failures: ["malformed_mandate"] };
  const order = buildOrderRequest(items);
  if (!order) return { type: "refused", failures: ["invalid_order"] };
  const s = await signer(deps);
  const agentJws = await signAgentRequest({ mandateHash: canonicalHash(payload), orderRequest: order }, s.privateKey, s.agentId);
  const r = await agentCheckout(db, { shopperJws, agentJws, items: order.items }, deps.checkoutDeps);
  if (r.status === 200) {
    return {
      type: "checkout",
      orderId: r.data.orderId,
      approveUrl: r.data.approveUrl,
      hash: r.data.hash,
      totalCents: order.amountCents,
      items: order.items.map((i) => ({ sku: i.sku, name: getProduct(i.sku)?.name ?? i.sku, qty: i.qty })),
    };
  }
  if (r.status === 422) return { type: "refused", failures: r.data.failures };
  return { type: "refused", failures: [], reason: r.data.error };
}

export function buildShopperTools(ctx: { db: Db; shopperJws: string; events: AgentEvent[] } & AgentDeps) {
  return {
    search_products: tool({
      description: "Search the Juniper & Thread catalog. Returns sku, name and price in cents.",
      inputSchema: z.object({ query: z.string().describe("Words to look for, e.g. 'silver hoops'. Empty lists everything.") }),
      execute: async ({ query }) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = products.filter((p) => {
          const hay = `${p.sku} ${p.name} ${p.description}`.toLowerCase();
          return words.length === 0 || words.some((w) => hay.includes(w.replace(/s$/, "")));
        });
        return { products: hits.map((p) => ({ sku: p.sku, name: p.name, priceCents: p.priceCents })) };
      },
    }),
    checkout: tool({
      description:
        "Start checkout for the items. The shopper's signed mandate is attached automatically. The merchant refuses anything outside the mandate. The human then approves in PayPal.",
      inputSchema: z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1) }),
      execute: async ({ items }) => {
        const ev = await agentSignedCheckout(ctx.db, ctx.shopperJws, items, ctx);
        ctx.events.push(ev);
        if (ev.type === "checkout") {
          return { ok: true, orderId: ev.orderId, total: formatMoney(ev.totalCents), next: "The shopper must approve the payment in PayPal." };
        }
        return { ok: false, refusedBecause: ev.failures.length ? ev.failures : ev.reason };
      },
    }),
  };
}

class CapReached extends Error {}

export type ChatDeps = AgentDeps & {
  consume?: () => Promise<boolean>;
  loadModel?: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  /** Records a 429/404 so the next loadModel picks a fallback model; true when switching models may help. */
  noteFailure?: (modelId: string, err: unknown) => boolean;
};

/** Gemini tool loop. Every model step consumes one slot of the daily AI cap; a refusal on the first step means the AI is unavailable. */
export async function runShopperChat(input: { db: Db; shopperJws: string; messages: ChatMessage[] }, deps: ChatDeps = {}): Promise<ChatResult> {
  const payload = decodeMandate(input.shopperJws);
  if (!payload) return { error: "That mandate could not be read. Sign a new one in your wallet." };
  const events: AgentEvent[] = [];
  const tools = buildShopperTools({ db: input.db, shopperJws: input.shopperJws, events, checkoutDeps: deps.checkoutDeps, agentSigner: deps.agentSigner });
  const consume = deps.consume ?? tryConsumeAiCall;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    const load = deps.loadModel ?? (() => getGeminiModel("fast"));
    const note = deps.noteFailure ?? ((id: string, e: unknown) => noteModelFailure(id, e));
    let model = await load();
    const loop = () => generateText({
      model,
      ...TOOL_LOOP_OPTIONS,
      tools,
      stopWhen: stepCountIs(MAX_SHOPPER_STEPS),
      prepareStep: async () => {
        if (!(await consume())) throw new CapReached();
        return undefined;
      },
      system:
        "You are the shopper's AI shopping assistant at Juniper & Thread, a handmade jewellery shop. " +
        "You act only inside the purchase mandate the shopper signed: " + mandateSummary(payload) +
        " Never exceed it: do not add items, raise quantities or pick pricier pieces. Use search_products to find items, then checkout. " +
        "After checkout, tell the shopper to approve the payment in PayPal. If the merchant refuses, explain why in plain words. Be brief.",
      messages: input.messages,
    } as never);
    let result: Awaited<ReturnType<typeof loop>>;
    try {
      result = await loop();
    } catch (err) {
      // The free Gemini tier often answers 503 "high demand", or 429 once a model's daily quota is spent. Retry the loop
      // once (after a pause on 503; on the next fallback model on 429/404), only while nothing has happened yet (no
      // checkout or refusal), so a retry can never place a second order. Every step still takes a cap slot.
      if (events.length > 0) throw err;
      if (isOverloaded(err)) await sleep(OVERLOAD_RETRY_MS);
      else if (note(modelIdOf(model), err)) model = await load();
      else throw err;
      result = await loop();
    }
    if (!result.text.trim() && events.length === 0) return { aiUnavailable: true };
    return { text: result.text, events };
  } catch (err) {
    console.warn("Shopper agent AI failed:", err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : "error");
    // A failure mid-loop with nothing to show (no order, no refusal) is an AI failure, not a result.
    if (events.length === 0) return { aiUnavailable: true };
    return { text: "", events };
  }
}

/** Deterministic path: checks out exactly the mandate items through the same signed checkout. */
export async function runWithoutAi(input: { db: Db; shopperJws: string }, deps: AgentDeps = {}): Promise<{ events: AgentEvent[] } | { error: string }> {
  const payload = decodeMandate(input.shopperJws);
  if (!payload) return { error: "That mandate could not be read. Sign a new one in your wallet." };
  return { events: [await agentSignedCheckout(input.db, input.shopperJws, payload.items, deps)] };
}
