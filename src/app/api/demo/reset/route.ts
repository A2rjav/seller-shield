import { db } from "@/lib/db/client";
import { demoErrorResponse } from "@/lib/demo/http";
import { resetDemo } from "@/lib/demo/reset";
import { getOrder } from "@/lib/paypal/orders";

export const dynamic = "force-dynamic";

/** Resets the shared demo, at most once per 2 minutes globally. Never deletes or changes anything at PayPal. */
export async function POST(): Promise<Response> {
  try {
    const r = await resetDemo(db, { getOrder });
    if (!r.ok && r.reason === "seed_failed") {
      return Response.json(
        { error: "The reset could not reload the sample orders from PayPal. You can try again right now.", warnings: r.warnings },
        { status: 503 },
      );
    }
    if (!r.ok) {
      return Response.json(
        { error: `The demo was reset very recently. Try again in ${r.retryAfterSec} seconds.`, retryAfterSec: r.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } },
      );
    }
    return Response.json({ ok: true, deleted: r.deleted, seeded: r.seeded, warnings: r.warnings });
  } catch (e) {
    return demoErrorResponse(e, "The reset failed. Try again in a moment.");
  }
}
