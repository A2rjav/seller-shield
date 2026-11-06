import { getPaypalConfig } from "@/lib/env";
import AgentChat from "./AgentChat";

export const dynamic = "force-dynamic";

function clientId(): string | null {
  try {
    return getPaypalConfig().clientId; // public id only
  } catch {
    return null;
  }
}

export default function AgentPage() {
  return <AgentChat clientId={clientId()} />;
}
