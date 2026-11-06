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
};

export function disputeAmount(d: Pick<PaypalDispute, "dispute_amount">): { amountCents: number; currency: string } {
  return { amountCents: toCents(d.dispute_amount.value), currency: d.dispute_amount.currency_code };
}

const base = (id: string) => `/v1/customer/disputes/${encodeURIComponent(id)}`;

export function createDisputesApi(client: Pick<PaypalClient, "paypalFetch">) {
  const f = client.paypalFetch;

  async function listDisputes(): Promise<PaypalDispute[]> {
    const res = await f<{ items?: PaypalDispute[] }>("/v1/customer/disputes", { method: "GET" });
    return res?.items ?? [];
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

  return { listDisputes, getDispute, provideEvidence, makeOffer, acceptClaim, sendMessage, requireEvidence, adjudicate };
}

const api = createDisputesApi({ paypalFetch });
export const listDisputes = api.listDisputes;
export const getDispute = api.getDispute;
export const provideEvidence = api.provideEvidence;
export const makeOffer = api.makeOffer;
export const acceptClaim = api.acceptClaim;
export const sendMessage = api.sendMessage;
export const requireEvidence = api.requireEvidence;
export const adjudicate = api.adjudicate;
