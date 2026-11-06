import { describe, expect, it } from "vitest";
import { createPaypalClient, PaypalError } from "@/lib/paypal/client";
import { createOrdersApi } from "@/lib/paypal/orders";
import { createTrackingApi } from "@/lib/paypal/tracking";
import { getPaypalConfig } from "@/lib/env";
import { config, fakeFetch, json, type Call } from "./helpers";

const links = [
  { rel: "self", href: "https://x/self" },
  { rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=O1" },
];

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
  return { ...f, client, orders: createOrdersApi(client), tracking: createTrackingApi(client) };
}
const orderCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/v2/checkout/orders"));
const input = { returnUrl: "https://app/ok", cancelUrl: "https://app/no" };

describe("createOrder", () => {
  it("computes total from catalog not caller", async () => {
    const t = setup((c) => (c.url.endsWith("/v2/checkout/orders") ? json(201, { id: "O1", links }) : undefined));
    const res = await t.orders.createOrder({ ...input, items: [{ sku: "silver-hoops", qty: 2 }] });
    expect(res).toEqual({ id: "O1", approveUrl: "https://sandbox.paypal.com/checkoutnow?token=O1" });
    const body = JSON.parse(orderCalls(t.calls)[0].init.body as string);
    const pu = body.purchase_units[0];
    expect(body.intent).toBe("CAPTURE");
    expect(pu.amount).toMatchObject({ currency_code: "USD", value: "120.00" });
    expect(pu.amount.breakdown.item_total.value).toBe("120.00");
    expect(pu.items[0]).toMatchObject({
      name: "Silver hoop earrings",
      sku: "silver-hoops",
      quantity: "2",
      unit_amount: { currency_code: "USD", value: "60.00" },
      category: "PHYSICAL_GOODS",
    });
    const ec = body.payment_source.paypal.experience_context;
    expect(ec).toMatchObject({
      return_url: "https://app/ok",
      cancel_url: "https://app/no",
      shipping_preference: "GET_FROM_FILE",
      user_action: "PAY_NOW",
      brand_name: "Juniper & Thread",
    });
    expect(pu.custom_id).toBeUndefined();
  });

  it("sets custom_id when given", async () => {
    const t = setup((c) => (c.url.endsWith("/v2/checkout/orders") ? json(201, { id: "O1", links }) : undefined));
    await t.orders.createOrder({ ...input, items: [{ sku: "woven-cuff", qty: 1 }], customId: "ord_123" });
    const body = JSON.parse(orderCalls(t.calls)[0].init.body as string);
    expect(body.purchase_units[0].custom_id).toBe("ord_123");
  });

  it("falls back to the approve link", async () => {
    const t = setup((c) =>
      c.url.endsWith("/v2/checkout/orders") ? json(201, { id: "O2", links: [{ rel: "approve", href: "https://a" }] }) : undefined,
    );
    const res = await t.orders.createOrder({ ...input, items: [{ sku: "woven-cuff", qty: 1 }] });
    expect(res.approveUrl).toBe("https://a");
  });

  it("rejects unknown sku, bad qty and long custom_id without any network call", async () => {
    const t = setup(() => undefined);
    await expect(t.orders.createOrder({ ...input, items: [{ sku: "nope", qty: 1 }] })).rejects.toThrow(/nope/);
    await expect(t.orders.createOrder({ ...input, items: [{ sku: "woven-cuff", qty: 0 }] })).rejects.toThrow(/quantity/i);
    await expect(t.orders.createOrder({ ...input, items: [{ sku: "woven-cuff", qty: 1.5 }] })).rejects.toThrow(/quantity/i);
    await expect(t.orders.createOrder({ ...input, items: [] })).rejects.toThrow();
    await expect(
      t.orders.createOrder({ ...input, items: [{ sku: "woven-cuff", qty: 1 }], customId: "x".repeat(128) }),
    ).rejects.toThrow(/custom/i);
    expect(t.calls).toHaveLength(0);
  });
});

describe("captureOrder", () => {
  const captured = {
    id: "O1",
    status: "COMPLETED",
    payer: { email_address: "buyer@example.com", payer_id: "PAYER1", name: { given_name: "Bo" } },
    purchase_units: [
      {
        shipping: {
          name: { full_name: "Bo Buyer" },
          address: {
            address_line_1: "1 Main St",
            address_line_2: "Apt 2",
            admin_area_2: "Austin",
            admin_area_1: "TX",
            postal_code: "78701",
            country_code: "US",
          },
        },
        payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "120.00" } }] },
      },
    ],
  };

  it("maps a realistic capture response", async () => {
    const t = setup((c) => (c.url.endsWith("/v2/checkout/orders/O1/capture") ? json(201, captured) : undefined));
    const r = await t.orders.captureOrder("O1");
    expect(r).toEqual({
      captureId: "CAP1",
      payerEmail: "buyer@example.com",
      payerId: "PAYER1",
      shipName: "Bo Buyer",
      shipAddress: { line1: "1 Main St", line2: "Apt 2", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" },
      amountCents: 12000,
      currency: "USD",
    });
    const cap = t.calls.find((c) => c.url.endsWith("/capture"))!;
    expect(cap.init.method).toBe("POST");
    expect(cap.init.headers["PayPal-Request-Id"]).toBeTruthy();
  });

  it("tolerates missing shipping", async () => {
    const noShip = { ...captured, purchase_units: [{ payments: captured.purchase_units[0].payments }] };
    const t = setup((c) => (c.url.endsWith("/capture") ? json(201, noShip) : undefined));
    const r = await t.orders.captureOrder("O1");
    expect(r.shipName).toBeNull();
    expect(r.shipAddress).toBeNull();
    expect(r.captureId).toBe("CAP1");
  });

  it("uses a stable request id per order so retries are idempotent", async () => {
    const t = setup((c) => (c.url.endsWith("/capture") ? json(201, captured) : undefined));
    await t.orders.captureOrder("O1");
    await t.orders.captureOrder("O1");
    const ids = t.calls.filter((c) => c.url.endsWith("/capture")).map((c) => c.init.headers["PayPal-Request-Id"]);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("addTracking", () => {
  it("posts to the order track endpoint", async () => {
    const t = setup((c) => (c.url.endsWith("/v2/checkout/orders/O1/track") ? json(201, { id: "O1" }) : undefined));
    await t.tracking.addTracking({ orderId: "O1", captureId: "CAP1", carrier: "USPS", trackingNumber: "9400", notifyPayer: true });
    const c = t.calls.find((x) => x.url.endsWith("/track"))!;
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(c.init.body as string)).toEqual({
      capture_id: "CAP1",
      tracking_number: "9400",
      carrier: "USPS",
      notify_payer: true,
    });
    expect(c.init.headers["PayPal-Request-Id"]).toBeTruthy();
  });
});

describe("paypalFetch", () => {
  it("sends PayPal-Request-Id on POST (given or random) and not on GET", async () => {
    const t = setup((c) => (c.url.includes("/v2/x") ? json(200, {}) : undefined));
    await t.client.paypalFetch("/v2/x", { method: "POST", body: {}, requestId: "fixed-1" });
    await t.client.paypalFetch("/v2/x", { method: "PATCH", body: [] });
    await t.client.paypalFetch("/v2/x", { method: "GET" });
    const xs = t.calls.filter((c) => c.url.includes("/v2/x"));
    expect(xs[0].init.headers["PayPal-Request-Id"]).toBe("fixed-1");
    expect(xs[1].init.headers["PayPal-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(xs[2].init.headers["PayPal-Request-Id"]).toBeUndefined();
    expect(xs[0].init.headers["Content-Type"]).toBe("application/json");
    expect(xs[0].init.headers.Authorization).toBe("Bearer tok");
  });

  it("token is reused across calls and refreshed near expiry", async () => {
    let now = 0;
    const f = fakeFetch((c) => (c.url.includes("/v2/x") ? json(200, {}) : undefined));
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => now });
    await client.paypalFetch("/v2/x", { method: "GET" });
    await client.paypalFetch("/v2/x", { method: "GET" });
    const tokenHits = () => f.calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length;
    expect(tokenHits()).toBe(1);
    now = 3600_000 - 59_000; // inside the 60s safety window
    await client.paypalFetch("/v2/x", { method: "GET" });
    expect(tokenHits()).toBe(2);
    const tok = f.calls.find((c) => c.url.endsWith("/v1/oauth2/token"))!;
    expect(tok.init.headers.Authorization).toBe("Basic " + Buffer.from("id:secret").toString("base64"));
    expect(String(tok.init.body)).toBe("grant_type=client_credentials");
  });

  it("concurrent callers share one token request", async () => {
    const f = fakeFetch((c) => (c.url.includes("/v2/x") ? json(200, {}) : undefined));
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    await Promise.all([1, 2, 3].map(() => client.paypalFetch("/v2/x", { method: "GET" })));
    expect(f.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("throws PaypalError parsed from the error body", async () => {
    const f = fakeFetch((c) =>
      c.url.includes("/v2/x")
        ? json(422, { name: "UNPROCESSABLE_ENTITY", message: "bad", debug_id: "dbg1", details: [{ issue: "X" }] })
        : undefined,
    );
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    const err = await client.paypalFetch("/v2/x", { method: "POST", body: {} }).catch((e: PaypalError) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect(err).toMatchObject({
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      message: "bad",
      debugId: "dbg1",
      details: [{ issue: "X" }],
    });
  });

  it("tolerates non-JSON error bodies and 204", async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/boom")) return new Response("<html>gateway</html>", { status: 502 });
      if (c.url.endsWith("/empty")) return new Response(null, { status: 204 });
      return undefined;
    });
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    const err = (await client.paypalFetch("/boom", { method: "GET" }).catch((e: unknown) => e)) as PaypalError;
    expect(err).toBeInstanceOf(PaypalError);
    expect(err.status).toBe(502);
    await expect(client.paypalFetch("/empty", { method: "POST" })).resolves.toBeUndefined();
  });

  it("on 401 drops the token and retries once", async () => {
    let n = 0;
    let tokens = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return json(200, { access_token: `t${++tokens}`, expires_in: 3600 });
      if (c.url.endsWith("/v2/x")) {
        return ++n === 1 ? json(401, { name: "AUTHENTICATION_FAILURE", message: "x" }) : json(200, { ok: true });
      }
      return undefined;
    });
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    await expect(client.paypalFetch("/v2/x", { method: "GET" })).resolves.toEqual({ ok: true });
    expect(tokens).toBe(2);
  });

  it("gives up after one 401 retry", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/v2/x") ? json(401, { name: "AUTHENTICATION_FAILURE", message: "x" }) : undefined));
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    const err = (await client.paypalFetch("/v2/x", { method: "GET" }).catch((e: unknown) => e)) as PaypalError;
    expect(err.status).toBe(401);
    expect(f.calls.filter((c) => c.url.endsWith("/v2/x"))).toHaveLength(2);
  });

  it("sends multipart without a Content-Type header", async () => {
    const t = setup((c) => (c.url.includes("/v2/x") ? json(200, {}) : undefined));
    const fd = new FormData();
    fd.append("a", "b");
    await t.client.paypalFetch("/v2/x", { method: "POST", multipart: fd });
    const c = t.calls.find((x) => x.url.includes("/v2/x"))!;
    expect(c.init.body).toBe(fd);
    expect(c.init.headers["Content-Type"]).toBeUndefined();
  });
});

describe("token hardening", () => {
  it("a 401 does not discard a token another call already refreshed", async () => {
    let tokens = 0;
    const seen: string[] = [];
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return json(200, { access_token: `t${++tokens}`, expires_in: 3600 });
      if (c.url.endsWith("/v2/a") || c.url.endsWith("/v2/b")) {
        seen.push(c.init.headers.Authorization);
        return c.init.headers.Authorization === "Bearer t1" ? json(401, { name: "AUTHENTICATION_FAILURE", message: "x" }) : json(200, { ok: true });
      }
      return undefined;
    });
    const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
    await client.paypalFetch("/v2/a", { method: "GET" }); // prime t1 is rejected, refreshes to t2
    expect(tokens).toBe(2);
    // Now simulate: B holds stale t1 result arriving after A refreshed. Run a stale-401 scenario directly.
    tokens = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f2 = fakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return json(200, { access_token: `t${++tokens}`, expires_in: 3600 });
      return undefined;
    });
    let slowSeen = false;
    const wrapped = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      if (String(url).endsWith("/v2/slow") && !slowSeen) {
        slowSeen = true;
        await gate; // hold the first request (using t1) until the other caller has refreshed
        return json(401, { name: "AUTHENTICATION_FAILURE", message: "x" });
      }
      if (String(url).endsWith("/v2/slow") || String(url).endsWith("/v2/fast")) {
        return init.headers.Authorization === "Bearer t1" && String(url).endsWith("/v2/fast")
          ? json(401, { name: "AUTHENTICATION_FAILURE", message: "x" })
          : json(200, { ok: true });
      }
      return f2.fetch(url, init);
    }) as unknown as typeof fetch;
    const client2 = createPaypalClient({ fetch: wrapped, config, now: () => 0 });
    const slow = client2.paypalFetch("/v2/slow", { method: "GET" }); // uses t1, parked
    await new Promise((r) => setTimeout(r, 0));
    await client2.paypalFetch("/v2/fast", { method: "GET" }); // 401 on t1, refreshes to t2
    expect(tokens).toBe(2);
    release(); // slow now gets its stale 401; cache already holds t2, so it must reuse it
    await slow;
    expect(tokens).toBe(2);
  });

  it("rejects malformed OAuth responses with PaypalError and caches nothing", async () => {
    for (const bad of [{ expires_in: 3600 }, { access_token: "t", expires_in: "soon" }, { access_token: "t" }, { access_token: "", expires_in: 5 }]) {
      let n = 0;
      const f = fakeFetch((c) => {
        if (c.url.endsWith("/v1/oauth2/token")) return ++n === 1 ? json(200, bad) : json(200, { access_token: "good", expires_in: 3600 });
        if (c.url.endsWith("/v2/x")) return json(200, { ok: true });
        return undefined;
      });
      const client = createPaypalClient({ fetch: f.fetch, config, now: () => 0 });
      const err = (await client.paypalFetch("/v2/x", { method: "GET" }).catch((e: unknown) => e)) as PaypalError;
      expect(err).toBeInstanceOf(PaypalError);
      expect(f.calls.some((c) => c.url.endsWith("/v2/x"))).toBe(false);
      // nothing cached: next call re-requests a token and succeeds with the good one
      await expect(client.paypalFetch("/v2/x", { method: "GET" })).resolves.toEqual({ ok: true });
      expect(n).toBe(2);
      expect(f.calls.find((c) => c.url.endsWith("/v2/x"))!.init.headers.Authorization).toBe("Bearer good");
    }
  });
});

describe("getPaypalConfig", () => {
  it("defaults to sandbox and refuses other hosts", () => {
    expect(getPaypalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).apiBase).toBe("https://api-m.sandbox.paypal.com");
    expect(() =>
      getPaypalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_API_BASE: "https://api-m.paypal.com" }),
    ).toThrow(/sandbox/i);
    expect(() => getPaypalConfig({ PAYPAL_CLIENT_ID: "a" })).toThrow(/PAYPAL_CLIENT_SECRET/);
  });
});
