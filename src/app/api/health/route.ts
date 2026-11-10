export const dynamic = "force-dynamic";

/** Liveness probe for Render: touches neither the database nor PayPal. */
export function GET(): Response {
  return Response.json({ ok: true });
}
