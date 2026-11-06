import { db } from "@/lib/db/client";
import { submitAccept } from "@/lib/defense/submit";

export const dynamic = "force-dynamic";

/** Requires { sellerConfirmed: true } in the body; nothing reaches PayPal without it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const result = await submitAccept(db, id, body && typeof body === "object" ? body : {});
  if (result.submitted) return Response.json(result);
  const status = /not found/i.test(result.error ?? "") ? 404 : /confirmation/i.test(result.error ?? "") ? 400 : /rejected/i.test(result.error ?? "") ? 502 : 409;
  return Response.json(result, { status });
}
