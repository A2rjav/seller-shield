import { z } from "zod";
import { db } from "@/lib/db/client";
import { runShopperChat, runWithoutAi } from "@/lib/agent/shopper-agent";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  shopperJws: z.string().min(1).max(20000),
  mode: z.enum(["ai", "deterministic"]).default("ai"),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) }))
    .max(30)
    .default([]),
});

/** Shopper agent chat. Returns { text, events }, or { aiUnavailable: true } when the AI is capped or down. */
export async function POST(req: Request): Promise<Response> {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { shopperJws, mode, messages } = parsed.data;
  try {
    if (mode === "deterministic") {
      const r = await runWithoutAi({ db, shopperJws });
      return Response.json(r, { status: "error" in r ? 400 : 200 });
    }
    if (messages.length === 0) return Response.json({ error: "Say something first" }, { status: 400 });
    const r = await runShopperChat({ db, shopperJws, messages });
    return Response.json(r, { status: "error" in r ? 400 : 200 });
  } catch (err) {
    console.error("Agent chat failed", err instanceof Error ? err.message : "error");
    return Response.json({ aiUnavailable: true });
  }
}
