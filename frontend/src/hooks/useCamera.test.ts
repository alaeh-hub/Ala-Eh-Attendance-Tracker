import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("captureFrame", () => {
  const blob = new Blob(["jpeg"], { type: "image/jpeg" });
  const drawImage = vi.fn();
  // The spies are typed loosely: they stand in for several DOM overloads.
  let getContext: any, toBlob: any, setWidth: any, setHeight: any;

  beforeEach(() => {
    drawImage.mockReset();
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage })) as any);
    toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: BlobCallback) => cb(blob)) as any);
    setWidth = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
    setHeight = vi.spyOn(HTMLCanvasElement.prototype, "height", "set");
  });
  afterEach(() => vi.restoreAllMocks());

  function camera(size: { videoWidth: number; videoHeight: number }) {
    const { result } = renderHook(() => useCamera());
    (result.current.videoRef as { current: unknown }).current = size;
    return result.current;
  }

  it("reads the picture back through a canvas made for frequent readback", async () => {
    const { captureFrame } = camera({ videoWidth: 1280, videoHeight: 720 });
    // Every capture is read straight back out as a JPEG. The default GPU-backed canvas stalls on that
    // (about 1300 ms against about 25 ms measured for the same capture), so it must not be used.
    await expect(captureFrame(0.6, 480)).resolves.toBe(blob);
    expect(getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 480, 270);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.6);
  });

  it("does not upscale a picture that is already smaller than asked for", async () => {
    const { captureFrame } = camera({ videoWidth: 320, videoHeight: 240 });
    await captureFrame(0.8, 480);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 320, 240);
  });

  it("only resizes the canvas when the size changes, since assigning a size clears and reallocates it", async () => {
    const { captureFrame } = camera({ videoWidth: 1280, videoHeight: 720 });
    await captureFrame(0.6, 480);
    const widthSets = setWidth.mock.calls.length;
    const heightSets = setHeight.mock.calls.length;
    expect(widthSets).toBe(1);
    expect(heightSets).toBe(1);

    await captureFrame(0.6, 480);
    await captureFrame(0.6, 480);
    expect(setWidth.mock.calls.length).toBe(widthSets);
    expect(setHeight.mock.calls.length).toBe(heightSets);

    await captureFrame(0.6, 320); // a different size does resize
    expect(setWidth.mock.calls.length).toBe(widthSets + 1);
  });

  it("gives nothing back before the camera has a picture", async () => {
    const { captureFrame } = camera({ videoWidth: 0, videoHeight: 0 });
    await expect(captureFrame()).resolves.toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("gives nothing back when the browser has no 2d canvas", async () => {
    getContext.mockImplementation((() => null) as any);
    const { captureFrame } = camera({ videoWidth: 640, videoHeight: 480 });
    await expect(captureFrame()).resolves.toBeNull();
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
