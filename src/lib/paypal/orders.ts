import { getProduct } from "@/lib/catalog";
import { toCents, toPaypalAmount } from "@/lib/money";
import { paypalFetch, type PaypalClient } from "./client";
import type { Address } from "./types";

export type CreateOrderInput = {
  items: { sku: string; qty: number }[];
  customId?: string;
  returnUrl: string;
  cancelUrl: string;
};

export type CapturedOrder = {
  captureId: string;
  payerEmail: string;
  payerId: string;
  shipName: string | null;
  shipAddress: Address | null;
  amountCents: number;
  currency: string;
  /** PayPal capture status, e.g. COMPLETED or PENDING. */
  status?: string;
};

const CURRENCY = "USD";
const BRAND = "Juniper & Thread";

type PpLink = { rel: string; href: string };
type PpAddress = {
  address_line_1?: string;
  address_line_2?: string;
  admin_area_2?: string;
  admin_area_1?: string;
  postal_code?: string;
  country_code?: string;
};
type PpCaptureResponse = {
  payer?: { email_address?: string; payer_id?: string };
  purchase_units?: {
    shipping?: { name?: { full_name?: string }; address?: PpAddress };
    payments?: { captures?: { id: string; status?: string; amount?: { value: string; currency_code: string } }[] };
  }[];
};

function mapAddress(a: PpAddress | undefined): Address | null {
  if (!a) return null;
  const out: Address = {
    line1: a.address_line_1 ?? "",
    city: a.admin_area_2 ?? "",
    state: a.admin_area_1 ?? "",
    postalCode: a.postal_code ?? "",
    countryCode: a.country_code ?? "",
  };
  if (a.address_line_2) out.line2 = a.address_line_2;
  return out;
}

/** Maps a PayPal order/capture response to CapturedOrder; null when it holds no capture. Shared by capture and recovery. */
export function mapCapturedOrder(res: unknown): CapturedOrder | null {
  const r = res as PpCaptureResponse;
  const pu = r.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  if (!cap) return null;
  return {
    captureId: cap.id,
    payerEmail: r.payer?.email_address ?? "",
    payerId: r.payer?.payer_id ?? "",
    shipName: pu?.shipping?.name?.full_name ?? null,
    shipAddress: mapAddress(pu?.shipping?.address),
    amountCents: toCents(cap.amount?.value ?? "0"),
    currency: cap.amount?.currency_code ?? CURRENCY,
    ...(cap.status ? { status: cap.status } : {}),
  };
}

/** The custom_id PayPal holds on the order (agent orders carry the mandate hash there); null when absent. */
export function readCustomId(res: unknown): string | null {
  const v = (res as { purchase_units?: { custom_id?: unknown }[] } | null)?.purchase_units?.[0]?.custom_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Tracking already attached to a captured PayPal order (GET order -> purchase_units[0].shipping.trackers), cancelled ones excluded.
 * PayPal returns tracker ids as "<captureId>-<trackingNumber>" and no carrier, so the carrier is inferred only for UPS "1Z" numbers.
 */
export function readTrackers(res: unknown): { trackingNumber: string; carrier: string | null }[] {
  const pu = (res as { purchase_units?: { shipping?: { trackers?: { id?: unknown; status?: unknown }[] }; payments?: { captures?: { id?: string }[] } }[] } | null)
    ?.purchase_units?.[0];
  const captureIds = (pu?.payments?.captures ?? []).map((c) => c.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const out: { trackingNumber: string; carrier: string | null }[] = [];
  for (const t of pu?.shipping?.trackers ?? []) {
    if (typeof t.id !== "string" || t.status === "CANCELLED") continue;
    const prefix = captureIds.find((c) => t.id !== c && (t.id as string).startsWith(`${c}-`));
    const trackingNumber = prefix ? t.id.slice(prefix.length + 1) : t.id;
    if (!trackingNumber) continue;
    out.push({ trackingNumber, carrier: /^1Z/i.test(trackingNumber) ? "UPS" : null });
  }
  return out;
}

/** Line items of a PayPal order, with amounts converted to cents. */
export function mapOrderItems(res: unknown): { sku: string; name: string; qty: number; priceCents: number }[] {
  const list =
    (res as { purchase_units?: { items?: { name?: string; sku?: string; quantity?: string; unit_amount?: { value?: string } }[] }[] })
      .purchase_units?.[0]?.items ?? [];
  return list.map((i) => ({
    sku: i.sku ?? "",
    name: i.name ?? i.sku ?? "Item",
    qty: Number.parseInt(i.quantity ?? "1", 10) || 1,
    priceCents: toCents(i.unit_amount?.value ?? "0"),
  }));
}

export function createOrdersApi(client: Pick<PaypalClient, "paypalFetch">) {
  async function createOrder(input: CreateOrderInput): Promise<{ id: string; approveUrl: string }> {
    if (input.items.length === 0) throw new Error("Order must contain at least one item");
    if (input.customId !== undefined && input.customId.length > 127) {
      throw new Error("custom_id must be at most 127 characters");
    }
    // Price strictly from the catalog; validate everything before any network call.
    let totalCents = 0;
    const items = input.items.map(({ sku, qty }) => {
      const product = getProduct(sku);
      if (!product) throw new Error(`Unknown sku: ${sku}`);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Invalid quantity for ${sku}: must be a positive integer`);
      totalCents += product.priceCents * qty;
      return {
        name: product.name,
        sku: product.sku,
        quantity: String(qty),
        unit_amount: { currency_code: CURRENCY, value: toPaypalAmount(product.priceCents) },
        category: "PHYSICAL_GOODS",
      };
    });
    const total = { currency_code: CURRENCY, value: toPaypalAmount(totalCents) };

    const order = await client.paypalFetch<{ id: string; links?: PpLink[] }>("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            ...(input.customId ? { custom_id: input.customId } : {}),
            amount: { ...total, breakdown: { item_total: total } },
            items,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              shipping_preference: "GET_FROM_FILE",
              user_action: "PAY_NOW",
              brand_name: BRAND,
            },
          },
        },
      },
    });
    const link = order.links?.find((l) => l.rel === "payer-action") ?? order.links?.find((l) => l.rel === "approve");
    if (!link) throw new Error(`PayPal order ${order.id} has no approval link`);
    return { id: order.id, approveUrl: link.href };
  }

  async function captureOrder(id: string): Promise<CapturedOrder> {
    const res = await client.paypalFetch<PpCaptureResponse>(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      method: "POST",
      body: {},
      requestId: `capture-${id}`, // stable per order so a retried capture is idempotent
    });
    const mapped = mapCapturedOrder(res);
    if (!mapped) throw new Error(`PayPal order ${id} capture response has no capture`);
    return mapped;
  }

  async function getOrder(id: string): Promise<unknown> {
    return client.paypalFetch<unknown>(`/v2/checkout/orders/${encodeURIComponent(id)}`, { method: "GET" });
  }

  return { createOrder, captureOrder, getOrder };
}

// Module-level defaults bound to the real, lazily configured client.
const api = createOrdersApi({ paypalFetch });
export const createOrder = api.createOrder;
export const captureOrder = api.captureOrder;
export const getOrder = api.getOrder;
