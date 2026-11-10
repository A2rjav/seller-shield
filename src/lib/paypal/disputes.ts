import { toCents, toPaypalAmount } from "@/lib/money";
import { paypalFetch, type PaypalClient } from "./client";

/** PayPal Customer Disputes v1 resource (only the fields this app reads). List items are partial summaries. */
export type PaypalDispute = {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  disputed_transactions?: { seller_transaction_id?: string }[];
  reason: string;
  status: string;
  dispute_amount: { currency_code: string; value: string };
  dispute_life_cycle_stage: string;
  seller_response_due_date?: string;
  dispute_outcome?: { outcome_code?: string };
  messages?: { posted_by: "BUYER" | "SELLER" | "ARBITER"; time_posted: string; content: string }[];
  /** HATEOAS links: the actions PayPal allows the seller right now (provide_evidence, provide_supporting_info, ...). */
  links?: { rel?: string; href?: string; method?: string }[];
};

/**
 * How the seller's documents can reach PayPal right now, from the dispute's links. Live 2026-11-10: a new
 * item-not-received case moved to stage CHARGEBACK / UNDER_PAYPAL_REVIEW about 3 minutes after the buyer filed it,
 * with only `provide_supporting_info` allowed, so provide-evidence would be refused.
 * "unknown" when PayPal sent no links (list items, older rows): callers keep the provide-evidence default.
 */
export type EvidenceRoute = "evidence" | "supporting_info" | "none" | "unknown";
export function evidenceRoute(d: Pick<PaypalDispute, "links"> | null | undefined): EvidenceRoute {
  const rels = d?.links?.map((l) => l.rel);
  if (!rels || rels.length === 0) return "unknown";
  if (rels.includes("provide_evidence")) return "evidence";
  if (rels.includes("provide_supporting_info")) return "supporting_info";
  return "none";
}

export const ACCEPT_BLOCKED_REASON = "PayPal is reviewing this dispute; it cannot be accepted from here right now.";

/** True when PayPal's links are present but offer no accept-claim action (no links at all means "not known": allowed). */
export function acceptClaimUnavailable(d: Pick<PaypalDispute, "links"> | null | undefined): boolean {
  const rels = d?.links?.map((l) => l.rel);
  return !!rels && rels.length > 0 && !rels.includes("accept_claim");
}

/** What the case page offers for a real dispute, from the freshest PayPal read (or the stored one). */
export function liveActions(d: Pick<PaypalDispute, "links" | "status"> | null | undefined): { evidenceRoute: EvidenceRoute; acceptBlockedReason: string | null } {
  const reviewing = String(d?.status ?? "").toUpperCase() === "UNDER_REVIEW";
  return { evidenceRoute: evidenceRoute(d), acceptBlockedReason: reviewing || acceptClaimUnavailable(d) ? ACCEPT_BLOCKED_REASON : null };
}

export function disputeAmount(d: Pick<PaypalDispute, "dispute_amount">): { amountCents: number; currency: string } {
  return { amountCents: toCents(d.dispute_amount.value), currency: d.dispute_amount.currency_code };
}

const base = (id: string) => `/v1/customer/disputes/${encodeURIComponent(id)}`;

export const LIST_PAGE_SIZE = 50;
export const LIST_MAX_PAGES = 5;
type ListResponse = { items?: PaypalDispute[]; links?: { rel?: string; href?: string }[] };

/** Path + query of the "next" link, only when it stays on the PayPal sandbox disputes list. */
function nextPath(links: ListResponse["links"]): string | null {
  const href = links?.find((l) => l.rel === "next")?.href;
  if (!href) return null;
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith(".paypal.com") || u.pathname !== "/v1/customer/disputes") return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export function createDisputesApi(client: Pick<PaypalClient, "paypalFetch">) {
  const f = client.paypalFetch;

  /** Up to LIST_MAX_PAGES pages of LIST_PAGE_SIZE, following PayPal's "next" links (only on the disputes path). */
  async function listDisputes(): Promise<PaypalDispute[]> {
    const all: PaypalDispute[] = [];
    let path: string | null = `/v1/customer/disputes?page_size=${LIST_PAGE_SIZE}`;
    for (let page = 0; path && page < LIST_MAX_PAGES; page++) {
      const res: ListResponse = await f<ListResponse>(path, { method: "GET" });
      all.push(...(res?.items ?? []));
      path = nextPath(res?.links);
    }
    return all;
  }

  function getDispute(id: string): Promise<PaypalDispute> {
    return f<PaypalDispute>(base(id), { method: "GET" });
  }

  /** Multipart: an `input` JSON part naming the document plus the file part with that name. */
  async function provideEvidence(id: string, input: { notes: string; evidenceType: string; pdf: Uint8Array }): Promise<void> {
    const name = "evidence.pdf";
    const form = new FormData();
    form.append(
      "input",
      new Blob([JSON.stringify({ evidences: [{ evidence_type: input.evidenceType, notes: input.notes, documents: [{ name }] }] })], { type: "application/json" }),
      "input.json",
    );
    form.append(name, new Blob([input.pdf as BlobPart], { type: "application/pdf" }), name);
    await f<unknown>(`${base(id)}/provide-evidence`, { method: "POST", multipart: form, requestId: `evidence-${id}-${input.evidenceType}` });
  }

  /** While PayPal reviews a claim: multipart `input` JSON with the notes, plus the evidence PDF as a document part. */
  async function provideSupportingInfo(id: string, input: { notes: string; pdf: Uint8Array }): Promise<void> {
    const name = "evidence.pdf";
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ notes: input.notes })], { type: "application/json" }), "input.json");
    form.append(name, new Blob([input.pdf as BlobPart], { type: "application/pdf" }), name);
    await f<unknown>(`${base(id)}/provide-supporting-info`, { method: "POST", multipart: form, requestId: `supporting-${id}` });
  }

  async function makeOffer(id: string, input: { amountCents: number; currency: string; note: string }): Promise<void> {
    await f<unknown>(`${base(id)}/make-offer`, {
      method: "POST",
      body: { note: input.note, offer_type: "REFUND", offer_amount: { currency_code: input.currency, value: toPaypalAmount(input.amountCents) } },
    });
  }

  async function acceptClaim(id: string, note: string): Promise<void> {
    await f<unknown>(`${base(id)}/accept-claim`, { method: "POST", body: { note } });
  }

  async function sendMessage(id: string, text: string): Promise<void> {
    await f<unknown>(`${base(id)}/send-message`, { method: "POST", body: { message: text } });
  }

  /** Sandbox only: moves a dispute to the "seller must provide evidence" state. */
  async function requireEvidence(id: string): Promise<void> {
    await f<unknown>(`${base(id)}/require-evidence`, { method: "POST", body: { action: "SELLER_EVIDENCE" } });
  }

  /** Sandbox only: settles a dispute. */
  async function adjudicate(id: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<void> {
    await f<unknown>(`${base(id)}/adjudicate`, { method: "POST", body: { adjudication_outcome: outcome } });
  }

  return { listDisputes, getDispute, provideEvidence, provideSupportingInfo, makeOffer, acceptClaim, sendMessage, requireEvidence, adjudicate };
}

const api = createDisputesApi({ paypalFetch });
export const listDisputes = api.listDisputes;
export const getDispute = api.getDispute;
export const provideEvidence = api.provideEvidence;
export const provideSupportingInfo = api.provideSupportingInfo;
export const makeOffer = api.makeOffer;
export const acceptClaim = api.acceptClaim;
export const sendMessage = api.sendMessage;
export const requireEvidence = api.requireEvidence;
export const adjudicate = api.adjudicate;
