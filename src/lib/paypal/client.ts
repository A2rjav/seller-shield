import { getPaypalConfig, type PaypalConfig } from "@/lib/env";

export class PaypalError extends Error {
  readonly status: number;
  readonly debugId: string | undefined;
  readonly details: unknown[];
  constructor(init: { status: number; name?: string; message?: string; debugId?: string; details?: unknown[] }) {
    super(init.message || `PayPal request failed with status ${init.status}`);
    this.status = init.status;
    this.name = init.name || "PaypalError";
    this.debugId = init.debugId;
    this.details = init.details ?? [];
  }
}

export type PaypalInit = { method: string; body?: unknown; requestId?: string; multipart?: FormData };
export type PaypalFetch = <T>(path: string, init: PaypalInit) => Promise<T>;
export type PaypalClient = { paypalFetch: PaypalFetch };

type Deps = { fetch?: typeof fetch; config: PaypalConfig | (() => PaypalConfig); now?: () => number };

const REFRESH_MARGIN_MS = 60_000;
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function createPaypalClient(deps: Deps): PaypalClient {
  const doFetch: typeof fetch = deps.fetch ?? ((...a) => fetch(...a));
  const now = deps.now ?? Date.now;
  const cfg = () => (typeof deps.config === "function" ? deps.config() : deps.config);

  let token: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function getToken(): Promise<string> {
    if (token && now() < token.expiresAt - REFRESH_MARGIN_MS) return token.value;
    if (inflight) return inflight;
    inflight = (async () => {
      const c = cfg();
      const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
      const res = await doFetch(`${c.apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) throw await toError(res);
      const data = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
      const ttl = Number(data?.expires_in);
      if (typeof data?.access_token !== "string" || !data.access_token || !Number.isFinite(ttl) || ttl <= 0) {
        // Malformed OAuth response: never cache it and never send "Bearer undefined".
        throw new PaypalError({ status: res.status, name: "INVALID_TOKEN_RESPONSE", message: "PayPal returned a malformed OAuth token response" });
      }
      token = { value: data.access_token, expiresAt: now() + ttl * 1000 };
      return token.value;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function send(path: string, init: PaypalInit): Promise<{ res: Response; usedToken: string }> {
    const method = init.method.toUpperCase();
    const usedToken = await getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${usedToken}` };
    let body: BodyInit | undefined;
    if (init.multipart) {
      body = init.multipart; // fetch sets the multipart boundary Content-Type itself
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    if (WRITE_METHODS.has(method)) headers["PayPal-Request-Id"] = init.requestId ?? crypto.randomUUID();
    return { res: await doFetch(`${cfg().apiBase}${path}`, { method, headers, body }), usedToken };
  }

  const paypalFetch: PaypalFetch = async <T>(path: string, init: PaypalInit) => {
    let { res, usedToken } = await send(path, init);
    if (res.status === 401) {
      // Only drop the cache if it still holds the token that failed; a concurrent
      // caller may already have refreshed it (avoids a token stampede).
      if (token?.value === usedToken) token = null;
      ({ res, usedToken } = await send(path, init));
    }
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return { paypalFetch };
}

type ErrorBody = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: unknown[];
  error?: string;
  error_description?: string;
};

async function toError(res: Response): Promise<PaypalError> {
  let parsed: ErrorBody = {};
  try {
    const text = await res.text();
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object") parsed = v as ErrorBody;
  } catch {
    // non-JSON body (e.g. an HTML gateway page): fall through with status only
  }
  return new PaypalError({
    status: res.status,
    name: parsed.name ?? parsed.error,
    message: parsed.message ?? parsed.error_description,
    debugId: parsed.debug_id,
    details: Array.isArray(parsed.details) ? parsed.details : [],
  });
}

let defaultClient: PaypalClient | undefined;
/** Default client: real fetch, config read lazily from env on first use. */
export function getPaypalClient(): PaypalClient {
  return (defaultClient ??= createPaypalClient({ config: () => getPaypalConfig() }));
}

export const paypalFetch: PaypalFetch = (path, init) => getPaypalClient().paypalFetch(path, init);
