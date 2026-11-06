import { vi } from "vitest";

export type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };

export function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake fetch: routes by URL; the token endpoint is answered automatically unless a route overrides it. */
export function fakeFetch(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: (init ?? {}) as Call["init"] };
    calls.push(call);
    const r = routes(call);
    if (r) return r;
    if (call.url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "tok", expires_in: 3600 });
    throw new Error(`unexpected fetch ${call.url}`);
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export const config = { clientId: "id", clientSecret: "secret", apiBase: "https://api-m.sandbox.paypal.com" };
