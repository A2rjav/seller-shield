import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/testDb";
import { aiUsage } from "@/lib/db/schema";
import { aiBudget } from "@/lib/ai/budget";

describe("aiBudget", () => {
  const now = new Date("2026-11-06T09:00:00Z");
  it("reports calls left today against the configured cap", async () => {
    const db = await createTestDb();
    await db.insert(aiUsage).values([{ day: "2026-11-06", calls: 12 }, { day: "2026-11-05", calls: 99 }]);
    expect(await aiBudget(db, now, { GEMINI_API_KEY: "k", AI_DAILY_CALL_LIMIT: "50" })).toEqual({ configured: true, used: 12, limit: 50, left: 38 });
  });
  it("defaults the cap to 300 and works without a Gemini key", async () => {
    const db = await createTestDb();
    expect(await aiBudget(db, now, {})).toEqual({ configured: false, used: 0, limit: 300, left: 300 });
  });
});
