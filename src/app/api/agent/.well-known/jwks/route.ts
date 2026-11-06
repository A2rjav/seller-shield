import { getAgentKeys } from "@/lib/agent/agent-keys";

export const dynamic = "force-dynamic";

/** Public key of the demo shopper agent, so anyone can verify its signatures. */
export async function GET(): Promise<Response> {
  const { publicJwk } = await getAgentKeys();
  return Response.json({ keys: [publicJwk] });
}
