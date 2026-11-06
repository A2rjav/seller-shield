import { db } from "@/lib/db/client";
import { pollDisputes } from "@/lib/disputes/ingest";
import { getDispute, listDisputes } from "@/lib/paypal/disputes";

export const dynamic = "force-dynamic";

async function run(): Promise<Response> {
  try {
    return Response.json(await pollDisputes(db, { listDisputes, getDispute }));
  } catch (err) {
    console.error("Dispute poll failed", err instanceof Error ? err.message : "error");
    return Response.json({ error: "poll failed" }, { status: 502 });
  }
}

export const GET = run;
export const POST = run;
