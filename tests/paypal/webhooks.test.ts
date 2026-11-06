import { describe, expect, it } from "vitest";
import { createPaypalClient } from "@/lib/paypal/client";
import { createWebhookApi } from "@/lib/paypal/webhooks";
import { config, fakeFetch, json } from "./helpers";

const headers = new Headers({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tid",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-01-01T00:00:00Z",
});
const body = JSON.stringify({ id: "WH-1", event_type: "X" });

function setup(status: string | undefined, webhookId: string | null = "WID") {
  const f = fakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? undefined : json(200, { verification_status: status })));
  const api = createWebhookApi({ client: createPaypalClient({ fetch: f.fetch, config }), webhookId: () => webhookId ?? undefined });
  return { api, all: f.calls };
}

describe("verifyWebhook", () => {
  it("maps headers and body into the verify request", async () => {
    const { api, all } = setup("SUCCESS");
    expect(await api.verifyWebhook(headers, body)).toBe(true);
    const c = all.find((x) => x.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    expect(JSON.parse(c.init.body as string)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/cert",
      transmission_id: "tid",
      transmission_sig: "sig",
      transmission_time: "2026-01-01T00:00:00Z",
      webhook_id: "WID",
      webhook_event: { id: "WH-1", event_type: "X" },
    });
  });
  it("is false on FAILURE", async () => {
    expect(await setup("FAILURE").api.verifyWebhook(headers, body)).toBe(false);
  });
  it("is false for missing headers, invalid JSON, or missing webhook id, without calling PayPal", async () => {
    const s = setup("SUCCESS", null);
    expect(await s.api.verifyWebhook(headers, body)).toBe(false);
    const s2 = setup("SUCCESS");
    expect(await s2.api.verifyWebhook(new Headers(), body)).toBe(false);
    expect(await s2.api.verifyWebhook(headers, "not json")).toBe(false);
    expect(s.all).toHaveLength(0);
    expect(s2.all).toHaveLength(0);
  });
  it("is false when PayPal errors", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? undefined : json(500, { name: "X" })));
    const api = createWebhookApi({ client: createPaypalClient({ fetch: f.fetch, config }), webhookId: () => "W" });
    expect(await api.verifyWebhook(headers, body)).toBe(false);
  });
});
