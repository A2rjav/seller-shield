import { generateText, stepCountIs, tool } from "ai";
import { getGeminiModel, tryConsumeAiCall } from "@/lib/ai/gemini";
import { getPaypalConfig } from "@/lib/env";
import { toCents } from "@/lib/money";
import { getDispute as restGetDispute, type PaypalDispute } from "@/lib/paypal/disputes";
import { getOrder as restGetOrder } from "@/lib/paypal/orders";
import type { EvidenceItem } from "@/lib/evidence/folder";

/**
 * Compatibility finding: @paypal/agent-toolkit 1.11 targets AI SDK v4 (nested ai@4.3.19, `parameters`, LanguageModelV1),
 * so its toolkit object cannot be handed to the installed ai v7 `generateText` as is. We still use the Toolkit for what it
 * does (the PayPal calls): `PayPalAgentToolkit.getTools()` restricted to the three read-only tools, each re-wrapped as a
 * v7 `tool({ inputSchema, execute })` that delegates to the toolkit's own `execute`.
 */
export const READ_ONLY_TOOLS = ["get_dispute", "get_order", "get_shipment_tracking"] as const;
export type ToolName = (typeof READ_ONLY_TOOLS)[number];
export type ToolCall = { tool: ToolName; result: unknown };

export type GatherContext = { disputeId: string; orderId?: string };
export type RunAgent = (ctx: GatherContext) => Promise<{ ok: true; calls: ToolCall[] } | { ok: false }>;

export type GatherDeps = {
  /** Our order id (from our DB); lets the agent look up the PayPal order and tracking. */
  orderId?: string;
  runAgent?: RunAgent;
  getDispute?: (id: string) => Promise<PaypalDispute>;
  getOrder?: (id: string) => Promise<unknown>;
};

const parse = (r: unknown): unknown => {
  if (typeof r !== "string") return r;
  try {
    return JSON.parse(r);
  } catch {
    return r;
  }
};

const day = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const usd = (value: string, currency: string) => {
  const c = toCents(value);
  const v = `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  return currency === "USD" ? `$${v}` : `${v} ${currency}`;
};
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function amountText(a: unknown): string | null {
  const x = rec(a);
  const value = str(x.value), cur = str(x.currency_code);
  if (!value || !cur) return null;
  try {
    return usd(value, cur);
  } catch {
    return null;
  }
}

function disputeItem(d: Rec): EvidenceItem | null {
  const id = str(d.dispute_id);
  if (!id) return null;
  const amt = amountText(d.dispute_amount);
  const opened = day(d.create_time);
  const due = day(d.seller_response_due_date);
  const parts = [
    `PayPal dispute ${id}`,
    opened ? `opened ${opened}` : null,
    str(d.reason) ? `reason ${d.reason}` : null,
    str(d.status) ? `status ${d.status}` : null,
    amt ? `amount ${amt}` : null,
    due ? `seller response due ${due}` : null,
  ].filter(Boolean);
  return {
    id: `ev:paypal:dispute:${id}`, kind: "dispute", title: "PayPal dispute record", at: str(d.create_time) ?? null,
    summary: parts.join(", "),
    data: { dispute_id: id, reason: d.reason, status: d.status, dispute_amount: d.dispute_amount, create_time: d.create_time, seller_response_due_date: d.seller_response_due_date },
    source: "paypal", simulated: false,
  };
}

function orderItems(o: Rec): EvidenceItem[] {
  const id = str(o.id);
  if (!id) return [];
  const items: EvidenceItem[] = [];
  const created = day(o.create_time);
  const pu = rec((Array.isArray(o.purchase_units) ? o.purchase_units : [])[0]);
  const cap = rec((Array.isArray(rec(pu.payments).captures) ? (rec(pu.payments).captures as unknown[]) : [])[0]);
  const total = amountText(pu.amount);
  items.push({
    id: `ev:paypal:order:${id}`, kind: "order", title: "PayPal order record", at: str(o.create_time) ?? null,
    summary: [`PayPal order ${id}`, created ? `created ${created}` : null, str(o.status) ? `status ${o.status}` : null, total ? `total ${total}` : null].filter(Boolean).join(", "),
    data: { id, status: o.status, create_time: o.create_time, amount: pu.amount }, source: "paypal", simulated: false,
  });
  const capId = str(cap.id);
  if (capId) {
    const amt = amountText(cap.amount);
    const when = day(cap.create_time);
    items.push({
      id: `ev:paypal:capture:${capId}`, kind: "capture", title: "PayPal capture record", at: str(cap.create_time) ?? str(o.create_time) ?? null,
      summary: [`PayPal capture ${capId}`, str(cap.status) ? `status ${cap.status}` : null, amt ? `amount ${amt}` : null, when ? `captured ${when}` : null].filter(Boolean).join(", "),
      data: { id: capId, status: cap.status, amount: cap.amount, create_time: cap.create_time }, source: "paypal", simulated: false,
    });
  }
  return items;
}

function trackingItem(t: Rec, orderId: string | undefined): EvidenceItem | null {
  const first = rec(Array.isArray(t.trackers) ? t.trackers[0] : t);
  const num = str(first.tracking_number);
  if (!num) return null;
  const key = str(first.transaction_id) ?? orderId ?? num;
  const when = day(first.last_updated_time) ?? day(first.create_time);
  return {
    id: `ev:paypal:tracking:${key}`, kind: "tracking", title: "PayPal shipment tracking record", at: str(first.last_updated_time) ?? str(first.create_time) ?? null,
    summary: [`PayPal shipment tracking ${num}`, str(first.carrier) ? `carrier ${first.carrier}` : null, str(first.status) ? `status ${first.status}` : null, when ? `updated ${when}` : null].filter(Boolean).join(", "),
    data: { tracking_number: num, carrier: first.carrier, status: first.status }, source: "paypal", simulated: false,
  };
}

/** Keeps only results about the requested dispute/order and a transaction tied to them; dedupes by id. */
function itemsFromCalls(calls: ToolCall[], ctx: GatherContext): EvidenceItem[] {
  const parsed = calls.map((c) => ({ tool: c.tool, r: rec(parse(c.result)) }));
  const out: EvidenceItem[] = [];
  const txns = new Set<string>();

  for (const { tool: t, r } of parsed) {
    if (t !== "get_dispute" || r.dispute_id !== ctx.disputeId) continue;
    const it = disputeItem(r);
    if (it) out.push(it);
    for (const x of Array.isArray(r.disputed_transactions) ? r.disputed_transactions : []) {
      const id = str(rec(x).seller_transaction_id);
      if (id) txns.add(id);
    }
  }
  for (const { tool: t, r } of parsed) {
    if (t !== "get_order" || !ctx.orderId || r.id !== ctx.orderId) continue;
    const items = orderItems(r);
    out.push(...items);
    for (const i of items) if (i.kind === "capture") txns.add(String(rec(i.data).id));
  }
  for (const { tool: t, r } of parsed) {
    if (t !== "get_shipment_tracking") continue;
    const first = rec(Array.isArray(r.trackers) ? r.trackers[0] : r);
    const txn = str(first.transaction_id);
    if (!txn || !txns.has(txn)) continue;
    const it = trackingItem(r, ctx.orderId);
    if (it) out.push(it);
  }
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

const pick = (o: Rec, keys: string[]): Rec => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const scrub = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v).replace(/[^\s"@\\]+@[^\s"@\\]+\.[A-Za-z]{2,}/g, "[redacted]"));

/** What the model sees: ids, statuses, amounts and dates only. No emails, names or street lines. */
export function redactForModel(name: string, result: unknown): unknown {
  const r = rec(parse(result));
  const amount = (a: unknown) => pick(rec(a), ["currency_code", "value"]);
  if (name === "get_dispute") {
    return scrub({
      ...pick(r, ["dispute_id", "status", "reason", "create_time", "update_time", "seller_response_due_date", "dispute_life_cycle_stage"]),
      dispute_amount: amount(r.dispute_amount),
      disputed_transactions: (Array.isArray(r.disputed_transactions) ? r.disputed_transactions : []).map((x) => pick(rec(x), ["seller_transaction_id"])),
    });
  }
  if (name === "get_order") {
    const units = Array.isArray(r.purchase_units) ? r.purchase_units : [];
    return scrub({
      ...pick(r, ["id", "status", "create_time"]),
      purchase_units: units.map((u) => ({
        amount: amount(rec(u).amount),
        captures: (Array.isArray(rec(rec(u).payments).captures) ? (rec(rec(u).payments).captures as unknown[]) : []).map((c) => ({
          ...pick(rec(c), ["id", "status", "create_time"]),
          amount: amount(rec(c).amount),
        })),
      })),
    });
  }
  const t = (x: unknown) => pick(rec(x), ["transaction_id", "tracking_number", "carrier", "status", "last_updated_time", "create_time"]);
  return scrub(Array.isArray(r.trackers) ? { trackers: r.trackers.map(t) } : t(r));
}

type LegacyTool = { description?: string; parameters: unknown; execute: (a: unknown) => Promise<unknown> };
export const MAX_AGENT_STEPS = 4;
class CapReached extends Error {}

/**
 * Gemini + the Toolkit's read-only tools. Every model step consumes one slot of the daily AI cap; when the cap
 * refuses, the loop stops and whatever was gathered so far is used.
 */
export function createToolkitAgent(deps: {
  consume: () => Promise<boolean>;
  loadTools: () => Promise<Record<string, LegacyTool>>;
  loadModel: () => Promise<unknown>;
}): RunAgent {
  return async ({ disputeId, orderId }) => {
    const calls: ToolCall[] = [];
    try {
      const tools: Record<string, unknown> = {};
      for (const [name, t] of Object.entries(await deps.loadTools())) {
        if (!(READ_ONLY_TOOLS as readonly string[]).includes(name)) continue; // read-only only
        tools[name] = tool({
          description: t.description,
          inputSchema: t.parameters as never,
          execute: async (args: unknown) => {
            try {
              const result = await t.execute(args);
              calls.push({ tool: name as ToolName, result }); // full result, for evidence
              return redactForModel(name, result) as never; // redacted view, for the model
            } catch (e) {
              return { error: e instanceof Error ? e.message : "tool failed" } as never;
            }
          },
        } as never);
      }
      await generateText({
        model: await deps.loadModel(),
        tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        prepareStep: async () => {
          if (!(await deps.consume())) throw new CapReached();
          return undefined;
        },
        system: "You gather PayPal-side facts for a dispute. Call the tools; do not summarise. Never invent ids.",
        prompt: `Call get_dispute for dispute ${disputeId}.${orderId ? ` Then call get_order for order ${orderId}, and get_shipment_tracking with order_id ${orderId} and the seller transaction id from the dispute.` : ""}`,
      } as never);
      return { ok: true, calls };
    } catch {
      return calls.length > 0 ? { ok: true, calls } : { ok: false };
    }
  };
}

/** Default agent wiring: real Toolkit (sandbox, read-only), real Gemini model, DB-backed AI cap. */
export const runToolkitAgent: RunAgent = createToolkitAgent({
  consume: tryConsumeAiCall,
  loadModel: getGeminiModel,
  loadTools: async () => {
    const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/ai-sdk");
    const cfg = getPaypalConfig();
    const toolkit = new PayPalAgentToolkit({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      configuration: { actions: { disputes: { get: true }, orders: { get: true }, shipment: { get: true } }, context: { sandbox: true } },
    });
    return toolkit.getTools() as unknown as Record<string, LegacyTool>;
  },
});

/** PayPal-side facts as evidence items. AI + Toolkit when available; direct REST when AI is capped or fails. */
export async function gatherWithToolkit(disputeId: string, deps: GatherDeps = {}): Promise<EvidenceItem[]> {
  const run = deps.runAgent ?? runToolkitAgent;
  let ran: Awaited<ReturnType<RunAgent>> = { ok: false };
  try {
    ran = await run({ disputeId, orderId: deps.orderId });
  } catch {
    // fall through to REST
  }
  if (ran.ok) {
    const items = itemsFromCalls(ran.calls, { disputeId, orderId: deps.orderId });
    if (items.length > 0) return items;
  }

  const calls: ToolCall[] = [];
  try {
    calls.push({ tool: "get_dispute", result: await (deps.getDispute ?? restGetDispute)(disputeId) });
  } catch {
    // dispute unreachable: report what we can
  }
  if (deps.orderId) {
    try {
      calls.push({ tool: "get_order", result: await (deps.getOrder ?? restGetOrder)(deps.orderId) });
    } catch {
      // order unreachable
    }
  }
  return itemsFromCalls(calls, { disputeId, orderId: deps.orderId });
}
