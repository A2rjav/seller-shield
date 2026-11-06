import { describe, expect, it } from "vitest";
import { createPaypalClient } from "@/lib/paypal/client";
import { createDisputesApi, disputeAmount } from "@/lib/paypal/disputes";
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
