import { db } from "@/lib/db/client";
import { buildCase } from "@/lib/defense/build-case";

export const dynamic = "force-dynamic";

/** Builds the case for a dispute (reuses the stored one unless { rebuild: true }). The PDF is served by /pdf. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { rebuild?: unknown } | null;
  try {
    const row = await buildCase(db, id, { rebuild: body?.rebuild === true });
    const { pdfBytes, ...rest } = row;
    return Response.json({ ...rest, hasPdf: !!pdfBytes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    if (/not found/i.test(msg)) return Response.json({ error: msg }, { status: 404 });
    console.error("Case build failed", id, msg);
    return Response.json({ error: "case build failed" }, { status: 500 });
  }
}
