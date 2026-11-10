import { describe, expect, it } from "vitest";
import { createPaypalClient } from "@/lib/paypal/client";
import { ACCEPT_BLOCKED_REASON, acceptClaimUnavailable, createDisputesApi, disputeAmount, evidenceRoute, liveActions } from "@/lib/paypal/disputes";
import { config, fakeFetch, json } from "./helpers";

function setup(reply: unknown = {}) {
  const f = fakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? undefined : json(200, reply)));
  const api = createDisputesApi(createPaypalClient({ fetch: f.fetch, config }));
  const last = () => f.calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")).at(-1)!;
  return { api, last };
}

describe("disputes api request shapes", () => {
  it("listDisputes unwraps items", async () => {
    const { api, last } = setup({ items: [{ dispute_id: "D1", update_time: "2026-01-01T00:00:00Z" }] });
    const r = await api.listDisputes();
    expect(r).toHaveLength(1);
    expect(last().url).toContain("/v1/customer/disputes");
    expect(last().init.method).toBe("GET");
  });

  it("listDisputes asks for 50 per page and follows next links, at most 5 pages (M5)", async () => {
    const base = "https://api-m.sandbox.paypal.com/v1/customer/disputes";
    let page = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return undefined;
      page++;
      return json(200, { items: [{ dispute_id: `D${page}` }], links: [{ rel: "next", href: `${base}?page_size=50&next_page_token=t${page}` }] });
    });
    const api = createDisputesApi(createPaypalClient({ fetch: f.fetch, config }));
    const r = await api.listDisputes();
    expect(r.map((d) => d.dispute_id)).toEqual(["D1", "D2", "D3", "D4", "D5"]);
    const urls = f.calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")).map((c) => c.url);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toBe(`${base}?page_size=50`);
    expect(urls[1]).toBe(`${base}?page_size=50&next_page_token=t1`);
  });

  it("listDisputes stops without a next link and never follows a link off the disputes path (M5)", async () => {
    const replies = [
      { items: [{ dispute_id: "A" }], links: [{ rel: "next", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&next_page_token=x" }] },
      { items: [{ dispute_id: "B" }], links: [{ rel: "next", href: "https://evil.example.com/v1/customer/disputes?x=1" }] },
    ];
    const f = fakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? undefined : json(200, replies.shift())));
    const api = createDisputesApi(createPaypalClient({ fetch: f.fetch, config }));
    expect((await api.listDisputes()).map((d) => d.dispute_id)).toEqual(["A", "B"]);
    expect(f.calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("listDisputes returns [] when there are no items", async () => {
    const { api } = setup({});
    expect(await api.listDisputes()).toEqual([]);
  });

  it("getDispute encodes the id", async () => {
    const { api, last } = setup({ dispute_id: "D 1" });
    await api.getDispute("D 1");
    expect(last().url).toMatch(/\/v1\/customer\/disputes\/D%201$/);
  });

  it("provideEvidence posts multipart with an input JSON part and the pdf", async () => {
    const { api, last } = setup({});
    await api.provideEvidence("D1", { notes: "n", evidenceType: "PROOF_OF_FULFILLMENT", pdf: new Uint8Array([1, 2, 3]) });
    const c = last();
    expect(c.url).toMatch(/\/v1\/customer\/disputes\/D1\/provide-evidence$/);
    expect(c.init.method).toBe("POST");
    expect(c.init.headers["PayPal-Request-Id"]).toBeTruthy();
    const form = c.init.body as FormData;
    const input = form.get("input") as Blob;
    expect(JSON.parse(await input.text())).toEqual({
      evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: "n", documents: [{ name: "evidence.pdf" }] }],
    });
    const file = form.get("evidence.pdf") as File;
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(3);
  });

  it("provideSupportingInfo posts multipart notes plus the pdf, with an idempotency id", async () => {
    const { api, last } = setup({});
    await api.provideSupportingInfo("PP-R-1", { notes: "n", pdf: new Uint8Array([1, 2, 3, 4]) });
    const c = last();
    expect(c.url).toMatch(/\/v1\/customer\/disputes\/PP-R-1\/provide-supporting-info$/);
    expect(c.init.method).toBe("POST");
    expect(c.init.headers["PayPal-Request-Id"]).toBeTruthy();
    const form = c.init.body as FormData;
    expect(JSON.parse(await (form.get("input") as Blob).text())).toEqual({ notes: "n" });
    const file = form.get("evidence.pdf") as File;
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(4);
  });

  it("evidenceRoute reads the seller actions PayPal allows from the dispute links", () => {
    const l = (...rels: string[]) => ({ links: rels.map((rel) => ({ rel })) });
    expect(evidenceRoute(l("self", "provide_evidence", "accept_claim"))).toBe("evidence");
    expect(evidenceRoute(l("self", "provide_supporting_info"))).toBe("supporting_info"); // live 2026-11-10, under PayPal review
    expect(evidenceRoute(l("self"))).toBe("none");
    expect(evidenceRoute({})).toBe("unknown");
    expect(evidenceRoute(null)).toBe("unknown");
  });

  it("liveActions decides the evidence route and the accept-claim state from fresh dispute data", () => {
    const l = (status: string, ...rels: string[]) => ({ status, links: rels.map((rel) => ({ rel })) });
    expect(liveActions(l("WAITING_FOR_SELLER_RESPONSE", "provide_evidence", "accept_claim"))).toEqual({ evidenceRoute: "evidence", acceptBlockedReason: null });
    expect(liveActions(l("UNDER_REVIEW", "self", "provide_supporting_info"))).toEqual({ evidenceRoute: "supporting_info", acceptBlockedReason: ACCEPT_BLOCKED_REASON });
    expect(liveActions(l("UNDER_REVIEW", "accept_claim")).acceptBlockedReason).toBe(ACCEPT_BLOCKED_REASON);
    expect(liveActions({ status: "OPEN" })).toEqual({ evidenceRoute: "unknown", acceptBlockedReason: null });
    expect(liveActions(null)).toEqual({ evidenceRoute: "unknown", acceptBlockedReason: null });
    expect(acceptClaimUnavailable({ links: [{ rel: "self" }] })).toBe(true);
    expect(acceptClaimUnavailable({})).toBe(false);
  });

  it("makeOffer sends a REFUND offer with a PayPal amount string", async () => {
    const { api, last } = setup({});
    await api.makeOffer("D1", { amountCents: 6000, currency: "USD", note: "refund" });
    expect(last().url).toMatch(/\/D1\/make-offer$/);
    expect(JSON.parse(last().init.body as string)).toEqual({
      note: "refund",
      offer_type: "REFUND",
      offer_amount: { currency_code: "USD", value: "60.00" },
    });
  });

  it("acceptClaim and sendMessage", async () => {
    const { api, last } = setup({});
    await api.acceptClaim("D1", "ok");
    expect(last().url).toMatch(/\/D1\/accept-claim$/);
    expect(JSON.parse(last().init.body as string)).toEqual({ note: "ok" });
    await api.sendMessage("D1", "hello");
    expect(last().url).toMatch(/\/D1\/send-message$/);
    expect(JSON.parse(last().init.body as string)).toEqual({ message: "hello" });
  });

  it("sandbox helpers", async () => {
    const { api, last } = setup({});
    await api.requireEvidence("D1");
    expect(last().url).toMatch(/\/D1\/require-evidence$/);
    expect(JSON.parse(last().init.body as string)).toEqual({ action: "SELLER_EVIDENCE" });
    await api.adjudicate("D1", "SELLER_FAVOR");
    expect(last().url).toMatch(/\/D1\/adjudicate$/);
    expect(JSON.parse(last().init.body as string)).toEqual({ adjudication_outcome: "SELLER_FAVOR" });
  });

  it("disputeAmount converts to cents", () => {
    expect(disputeAmount({ dispute_amount: { currency_code: "USD", value: "60.50" } } as never)).toEqual({ amountCents: 6050, currency: "USD" });
  });
});
