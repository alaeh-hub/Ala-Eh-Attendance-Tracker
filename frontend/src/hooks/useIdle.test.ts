import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAKE_EVENT, useIdle } from "./useIdle";

describe("useIdle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const touch = () => act(() => void window.dispatchEvent(new Event("touchstart")));

  it("goes idle after the timeout and wakes on activity", () => {
    const { result } = renderHook(() => useIdle(1000));
    expect(result.current).toBe(false);
    tick(999);
    expect(result.current).toBe(false);
    tick(2);
    expect(result.current).toBe(true);
    touch();
    expect(result.current).toBe(false);
  });

  it("wakes on the wake event, with no touch at all", () => {
    const { result } = renderHook(() => useIdle(1000));
    tick(1500);
    expect(result.current).toBe(true);
    act(() => void window.dispatchEvent(new Event(WAKE_EVENT)));
    expect(result.current).toBe(false);
  });

  it("activity restarts the countdown", () => {
    const { result } = renderHook(() => useIdle(1000));
    tick(800);
    touch();
    tick(800);
    expect(result.current).toBe(false);
    tick(300);
    expect(result.current).toBe(true);
  });

  it("never goes idle while paused, and restarts the full countdown when resumed", () => {
    const { result, rerender } = renderHook(({ paused }) => useIdle(1000, paused), { initialProps: { paused: true } });
    tick(5000);
    expect(result.current).toBe(false);
    rerender({ paused: false });
    tick(900);
    expect(result.current).toBe(false); // the clock started when it resumed, not 5s ago
    tick(200);
    expect(result.current).toBe(true);
  });

  it("pausing while idle wakes it (a scan starting must clear the idle screen)", () => {
    const { result, rerender } = renderHook(({ paused }) => useIdle(1000, paused), { initialProps: { paused: false } });
    tick(1500);
    expect(result.current).toBe(true);
    rerender({ paused: true });
    expect(result.current).toBe(false);
  });
});
