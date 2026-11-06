import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cases } from "@/lib/db/schema";
import { caseId } from "@/lib/defense/build-case";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const [row] = await db.select().from(cases).where(eq(cases.id, caseId(id)));
  if (!row?.pdfBytes) return Response.json({ error: "no case built for this dispute" }, { status: 404 });
  return new Response(row.pdfBytes as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="evidence-${id.replace(/[^\w.-]/g, "_")}.pdf"`,
    },
  });
}
