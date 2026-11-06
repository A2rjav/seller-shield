import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { aiUsage } from "@/lib/db/schema";
import { utcDay } from "./gemini";

export type AiBudget = { configured: boolean; used: number; limit: number; left: number };

function dailyLimit(env: Record<string, string | undefined>): number {
  const n = Number(env.AI_DAILY_CALL_LIMIT?.trim() || 300);
  return Number.isInteger(n) && n > 0 ? n : 300;
}

/** Today's (UTC) Gemini calls against the daily cap. Works without a Gemini key (then `configured` is false). */
export async function aiBudget(db: Db, now: Date = new Date(), env: Record<string, string | undefined> = process.env): Promise<AiBudget> {
  const limit = dailyLimit(env);
  const [row] = await db.select({ calls: aiUsage.calls }).from(aiUsage).where(eq(aiUsage.day, utcDay(now)));
  const used = row?.calls ?? 0;
  return { configured: !!env.GEMINI_API_KEY?.trim(), used, limit, left: Math.max(0, limit - used) };
}
