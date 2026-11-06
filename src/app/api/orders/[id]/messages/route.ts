import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { messages, orders } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const body = z.object({ body: z.string().trim().min(1).max(2000) });

/** Shared demo: one order cannot be flooded with messages. */
const MAX_MESSAGES_PER_ORDER = 20;

/** Stores a buyer message from the storefront. Accepts JSON or a plain form post (then redirects back). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const isForm = (req.headers.get("content-type") ?? "").includes("form");
  const raw = isForm ? Object.fromEntries(await req.formData().catch(() => new FormData())) : await req.json().catch(() => null);
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Message must be 1-2000 characters" }, { status: 400 });

  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id));
  if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

  const [{ n }] = await db.select({ n: count() }).from(messages).where(eq(messages.orderId, id));
  if (n >= MAX_MESSAGES_PER_ORDER) {
    return Response.json({ error: `This order already has ${MAX_MESSAGES_PER_ORDER} messages, the most it can hold.` }, { status: 409 });
  }

  await db.insert(messages).values({
    id: crypto.randomUUID(),
    orderId: id,
    author: "buyer",
    body: parsed.data.body,
    source: "storefront",
  });
  if (isForm) return new Response(null, { status: 303, headers: { Location: `/order/${encodeURIComponent(id)}` } });
  return Response.json({ ok: true }, { status: 201 });
}
