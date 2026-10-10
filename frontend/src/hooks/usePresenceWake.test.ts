import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenceWake } from "./usePresenceWake";

describe("usePresenceWake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  // Plays back a scripted sequence of results, one per check; stays on the last one.
  const script = (...results: (boolean | Error)[]) => {
    let i = 0;
    return vi.fn(async () => {
      const r = results[Math.min(i++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    });
  };

  it("wakes for someone who arrives after the spot was empty", async () => {
    const onWake = vi.fn();
    renderHook(() => usePresenceWake({ enabled: true, check: script(false, true, true), onWake, intervalMs: 100 }));
    await run(1000);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("needs consecutive sightings: one noisy frame does not wake it", async () => {
    const onWake = vi.fn();
    renderHook(() => usePresenceWake({ enabled: true, check: script(false, true, false, true, false), onWake, intervalMs: 100 }));
    await run(1000);
    expect(onWake).not.toHaveBeenCalled();
  });

  it("ignores someone who was already standing there when the idle screen came up", async () => {
    const onWake = vi.fn();
    renderHook(() => usePresenceWake({ enabled: true, check: script(true), onWake, intervalMs: 100 }));
    await run(2000);
    expect(onWake).not.toHaveBeenCalled();
  });

  it("wakes for that person once they have stepped away and come back", async () => {
    const onWake = vi.fn();
    renderHook(() => usePresenceWake({ enabled: true, check: script(true, true, false, true, true), onWake, intervalMs: 100 }));
    await run(1000);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled, and stops when disabled again", async () => {
    const check = script(false, true, true);
    const onWake = vi.fn();
    const { rerender } = renderHook(({ enabled }) => usePresenceWake({ enabled, check, onWake, intervalMs: 100 }), { initialProps: { enabled: false } });
    await run(1000);
    expect(check).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await run(150);
    rerender({ enabled: false });
    const calls = check.mock.calls.length;
    await run(1000);
    expect(check.mock.calls.length).toBe(calls);
  });

  it("treats a failed check as no information, neither waking nor counting as empty", async () => {
    const onWake = vi.fn();
    renderHook(() =>
      usePresenceWake({ enabled: true, check: script(new Error("offline"), true, true, true), onWake, intervalMs: 100 })
    );
    await run(1000);
    // Never saw the spot empty, so the person present throughout does not wake it.
    expect(onWake).not.toHaveBeenCalled();
  });
});
