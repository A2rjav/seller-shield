import { describe, expect, it, vi } from "vitest";
import { createPollThrottle } from "@/lib/disputes/pollThrottle";

function setup() {
  let t = 1_000_000;
  const poll = vi.fn(async () => ({ checked: 2, created: 1, changed: 1 }));
  const th = createPollThrottle({ poll, now: () => t });
  return { th, poll, advance: (ms: number) => (t += ms) };
}

describe("poll throttle", () => {
  it("second trigger within 30s returns the cached result without polling", async () => {
    const { th, poll, advance } = setup();
    const first = await th.trigger();
    expect(first).toMatchObject({ checked: 2, created: 1, changed: 1 });
    expect(first.cached).toBeUndefined();
    advance(29_999);
    const second = await th.trigger();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ checked: 2, cached: true, lastPolledAt: first.lastPolledAt });
  });

  it("polls again after 30s", async () => {
    const { th, poll, advance } = setup();
    await th.trigger();
    advance(30_000);
    const r = await th.trigger();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(r.cached).toBeUndefined();
  });

  it("last() never polls and reports null before any poll", async () => {
    const { th, poll } = setup();
    expect(th.last()).toEqual({ lastPolledAt: null });
    await th.trigger();
    expect(th.last()).toMatchObject({ checked: 2 });
    th.last();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("concurrent triggers share one poll; a failed poll starts no cooldown", async () => {
    const { th, poll } = setup();
    await Promise.all([th.trigger(), th.trigger()]);
    expect(poll).toHaveBeenCalledTimes(1);
    const bad = createPollThrottle({ poll: vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue({ checked: 0, created: 0, changed: 0 }) });
    await expect(bad.trigger()).rejects.toThrow();
    expect((await bad.trigger()).cached).toBeUndefined();
  });
});
