export type PollResult = { checked: number; created: number; changed: number };
export type PollState = Partial<PollResult> & { lastPolledAt: string | null; cached?: boolean };

export const POLL_COOLDOWN_MS = 30_000;

/**
 * Global in-memory cooldown around a poller. `trigger` runs the poller at most once per
 * cooldown window and otherwise returns the last result flagged `cached`; `last` never polls.
 * A failed poll does not start a cooldown.
 */
export function createPollThrottle(deps: { poll: () => Promise<PollResult>; now?: () => number; cooldownMs?: number }) {
  const now = deps.now ?? Date.now;
  const cooldown = deps.cooldownMs ?? POLL_COOLDOWN_MS;
  let state: { at: number; result: PollResult } | null = null;
  let inflight: Promise<PollState> | null = null;

  const view = (cached: boolean): PollState =>
    state ? { ...state.result, lastPolledAt: new Date(state.at).toISOString(), ...(cached ? { cached: true } : {}) } : { lastPolledAt: null };

  async function trigger(): Promise<PollState> {
    if (state && now() - state.at < cooldown) return view(true);
    if (inflight) return inflight;
    inflight = (async () => {
      const result = await deps.poll();
      state = { at: now(), result };
      return view(false);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { trigger, last: () => view(false) };
}
