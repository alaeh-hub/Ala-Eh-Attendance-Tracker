import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSECURE_CONTEXT_ERROR, frameDifference, useCamera } from "./useCamera";

describe("useCamera", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains that the camera needs HTTPS on an insecure page", async () => {
    vi.stubGlobal("isSecureContext", false);
    const { result } = renderHook(() => useCamera());
    await act(() => result.current.start());
    expect(result.current.error).toBe(INSECURE_CONTEXT_ERROR);
    expect(result.current.ready).toBe(false);
  });

  it("reports the same when the browser has no camera API", async () => {
    vi.stubGlobal("isSecureContext", true);
    const mediaDevices = (navigator as any).mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const { result } = renderHook(() => useCamera());
    await act(() => result.current.start());
    expect(result.current.error).toBe(INSECURE_CONTEXT_ERROR);
    Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  });

  it("starts the camera when it is available", async () => {
    vi.stubGlobal("isSecureContext", true);
    const track = { stop: vi.fn(), addEventListener: vi.fn(), readyState: "live", getSettings: () => ({ deviceId: "cam-1" }) };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const mediaDevices = (navigator as any).mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: "videoinput", deviceId: "cam-1", label: "Webcam" }]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const { result, unmount } = renderHook(() => useCamera());
    await act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(result.current.ready).toBe(true);
    expect(result.current.deviceId).toBe("cam-1");
    unmount();
    expect(track.stop).toHaveBeenCalled();
    Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  });
});

describe("frameDifference", () => {
  it("is 0 for identical frames and grows with change", () => {
    const a = new Uint8ClampedArray([10, 20, 30, 40]);
    expect(frameDifference(a, a)).toBe(0);
    expect(frameDifference(a, new Uint8ClampedArray([14, 24, 34, 44]))).toBe(4);
  });

  it("is Infinity when frames can't be compared", () => {
    expect(frameDifference(null, new Uint8ClampedArray(4))).toBe(Infinity);
    expect(frameDifference(new Uint8ClampedArray(2), new Uint8ClampedArray(4))).toBe(Infinity);
  });
});
