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

function itemsFromCalls(calls: ToolCall[], orderId?: string): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const c of calls) {
    const r = rec(parse(c.result));
    if (c.tool === "get_dispute") out.push(...(disputeItem(r) ? [disputeItem(r)!] : []));
    else if (c.tool === "get_order") out.push(...orderItems(r));
    else {
      const t = trackingItem(r, orderId);
      if (t) out.push(t);
    }
  }
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/** Default agent: Gemini + the Toolkit's read-only PayPal tools. Counts one call against the daily AI cap. */
export const runToolkitAgent: RunAgent = async ({ disputeId, orderId }) => {
  if (!(await tryConsumeAiCall())) return { ok: false };
  try {
    const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/ai-sdk");
    const cfg = getPaypalConfig();
    const toolkit = new PayPalAgentToolkit({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      configuration: { actions: { disputes: { get: true }, orders: { get: true }, shipment: { get: true } }, context: { sandbox: true } },
    });
    const calls: ToolCall[] = [];
    const tools: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(toolkit.getTools())) {
      if (!(READ_ONLY_TOOLS as readonly string[]).includes(name)) continue; // belt and braces: read-only only
      const legacy = t as unknown as { description?: string; parameters: unknown; execute: (a: unknown) => Promise<unknown> };
      tools[name] = tool({
        description: legacy.description,
        inputSchema: legacy.parameters as never,
        execute: async (args: unknown) => {
          try {
            const result = await legacy.execute(args);
            calls.push({ tool: name as ToolName, result });
            return result as never;
          } catch (e) {
            return { error: e instanceof Error ? e.message : "tool failed" } as never;
          }
        },
      } as never);
    }
    await generateText({
      model: await getGeminiModel(),
      tools,
      stopWhen: stepCountIs(6),
      system: "You gather PayPal-side facts for a dispute. Call the tools; do not summarise. Never invent ids.",
      prompt: `Call get_dispute for dispute ${disputeId}.${orderId ? ` Then call get_order for order ${orderId}, and get_shipment_tracking with order_id ${orderId} and the seller transaction id from the dispute.` : ""}`,
    } as never);
    return { ok: true, calls };
  } catch {
    return { ok: false };
  }
};

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
    const items = itemsFromCalls(ran.calls, deps.orderId);
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
  return itemsFromCalls(calls, deps.orderId);
}
