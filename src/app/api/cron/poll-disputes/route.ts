import { db } from "@/lib/db/client";
import { pollDisputes } from "@/lib/disputes/ingest";
import { createPollThrottle } from "@/lib/disputes/pollThrottle";
import { getDispute, listDisputes } from "@/lib/paypal/disputes";

export const dynamic = "force-dynamic";

const throttle = createPollThrottle({ poll: () => pollDisputes(db, { listDisputes, getDispute }) });

/** GET is read-only: returns the last poll result and never calls PayPal or writes. */
export async function GET(): Promise<Response> {
  return Response.json(throttle.last());
}

/** POST triggers a poll, at most once per 30 seconds globally. */
export async function POST(): Promise<Response> {
  try {
    return Response.json(await throttle.trigger());
  } catch (err) {
    console.error("Dispute poll failed", err instanceof Error ? err.message : "error");
    return Response.json({ error: "poll failed" }, { status: 502 });
  }
}
