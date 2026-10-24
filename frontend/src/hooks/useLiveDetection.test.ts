import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FaceDebug } from "../utils/faceDebug";
import { LIVE_INTERVAL_MS, useLiveDetection } from "./useLiveDetection";

const { post, zone } = vi.hoisted(() => ({ post: vi.fn(), zone: vi.fn() }));
vi.mock("../services/api", () => ({ default: { post } }));
vi.mock("../utils/guideZone", () => ({ guideZone: zone }));

const reading = (ms: number): FaceDebug => ({ image: { w: 640, h: 480 }, faces: [], zone: null, live: true, ms });
const frame = new Blob(["x"], { type: "image/jpeg" });
const apiError = (status: number) => Object.assign(new Error(String(status)), { response: { status } });

const refs = { videoRef: { current: null }, ovalRef: { current: null } };

function mount(overrides: Partial<Parameters<typeof useLiveDetection>[0]> = {}) {
  const report = vi.fn();
  const captureFrame = vi.fn(() => Promise.resolve(frame as Blob | null));
  const props = { enabled: true, captureFrame, report, ...refs, ...overrides };
  const view = renderHook((p: typeof props) => useLiveDetection(p), { initialProps: props });
  return { ...view, report, captureFrame, props };
}

const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  post.mockReset().mockImplementation(() => Promise.resolve({ data: { debug: reading(12) } }));
  zone.mockReset().mockReturnValue(null);
});
afterEach(() => vi.useRealTimers());

describe("useLiveDetection", () => {
  it("sends a small frame straight away and reports what the server saw", async () => {
    const { report, captureFrame } = mount();
    await flush();

    expect(captureFrame).toHaveBeenCalledWith(0.6, 480);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, form] = post.mock.calls[0];
    expect(url).toBe("/recognition/debug-detect");
    expect((form as FormData).get("frame")).toBeInstanceOf(Blob);
    expect(report).toHaveBeenCalledWith(reading(12));
  });

  it("keeps going at the live rhythm", async () => {
    mount();
    await flush(LIVE_INTERVAL_MS * 4 + 10);
    expect(post.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(post.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("sends where the guide oval is", async () => {
    zone.mockReturnValue({ cx: 0.5, cy: 0.45, rx: 0.2, ry: 0.4 });
    mount();
    await flush();
    expect(JSON.parse((post.mock.calls[0][1] as FormData).get("zone") as string)).toEqual({ cx: 0.5, cy: 0.45, rx: 0.2, ry: 0.4 });
  });

  it("sends no zone when the oval can't be measured yet", async () => {
    mount();
    await flush();
    expect((post.mock.calls[0][1] as FormData).get("zone")).toBeNull();
  });

  it("never has two requests in flight: the next frame waits for the last answer", async () => {
    let answer!: (v: unknown) => void;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    mount();
    await flush(LIVE_INTERVAL_MS * 5); // a slow server: the first answer has not come back
    expect(post).toHaveBeenCalledTimes(1);

    answer({ data: { debug: reading(900) } });
    await flush(LIVE_INTERVAL_MS + 10);
    expect(post.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does nothing while disabled, and stops when it becomes disabled", async () => {
    const { rerender, props } = mount({ enabled: false });
    await flush(LIVE_INTERVAL_MS * 3);
    expect(post).not.toHaveBeenCalled();

    rerender({ ...props, enabled: true });
    await flush(LIVE_INTERVAL_MS * 2);
    const sent = post.mock.calls.length;
    expect(sent).toBeGreaterThan(0);

    rerender({ ...props, enabled: false });
    await flush(LIVE_INTERVAL_MS * 4);
    expect(post.mock.calls.length).toBe(sent);
  });

  it("drops an answer that arrives after it was switched off", async () => {
    let answer!: (v: unknown) => void;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const { rerender, props, report } = mount();
    await flush();
    rerender({ ...props, enabled: false });
    answer({ data: { debug: reading(5) } });
    await flush(LIVE_INTERVAL_MS * 2);
    expect(report).not.toHaveBeenCalled();
  });

  it("stops on unmount", async () => {
    const { unmount } = mount();
    await flush();
    unmount();
    const sent = post.mock.calls.length;
    await flush(LIVE_INTERVAL_MS * 4);
    expect(post.mock.calls.length).toBe(sent);
  });

  it("keeps trying while the camera has no picture yet, without sending anything", async () => {
    const captureFrame = vi.fn(() => Promise.resolve(null as Blob | null));
    mount({ captureFrame });
    await flush(LIVE_INTERVAL_MS * 3);
    expect(captureFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(post).not.toHaveBeenCalled();
  });

  it("reports 'no debug data' and backs right off when the server is in production mode (404)", async () => {
    post.mockImplementation(() => Promise.reject(apiError(404)));
    const { report } = mount();
    await flush();
    expect(report).toHaveBeenCalledWith(undefined);

    await flush(4000);
    expect(post).toHaveBeenCalledTimes(1); // not hammering a server that will never answer
    await flush(1100);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("slows down when rate limited, and eases off after other errors", async () => {
    post.mockImplementation(() => Promise.reject(apiError(429)));
    mount();
    await flush(1900);
    expect(post).toHaveBeenCalledTimes(1);
    await flush(200);
    expect(post).toHaveBeenCalledTimes(2);

    post.mockReset().mockImplementation(() => Promise.reject(new Error("Network Error")));
    const second = mount();
    await flush(900);
    const failed = post.mock.calls.length;
    await flush(200);
    expect(post.mock.calls.length).toBe(failed + 1);
    expect(second.report).not.toHaveBeenCalled();
  });
});
