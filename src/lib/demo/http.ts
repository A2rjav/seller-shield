import { DemoError } from "./simulate";

/** Maps a DemoError to its status and message; anything else is logged (message only) and becomes a 500. */
export function demoErrorResponse(e: unknown, fallback: string): Response {
  if (e instanceof DemoError) return Response.json({ error: e.message }, { status: e.status });
  console.error(fallback, e instanceof Error ? e.message : "error");
  return Response.json({ error: fallback }, { status: 500 });
}
