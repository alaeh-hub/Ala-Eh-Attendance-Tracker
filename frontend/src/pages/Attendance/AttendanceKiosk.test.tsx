import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { admin } from "../../test/fixtures";
import AttendanceKiosk, { CONNECTION_ERROR_TEXT } from "./AttendanceKiosk";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../services/api", () => ({
  default: { get, post },
  errorMessage: (_e: unknown, fallback?: string) => fallback ?? "error",
  getAccessToken: () => "t",
  setAccessToken: vi.fn(),
  refreshSession: vi.fn(),
  hasRefreshCookie: () => false,
  isAuthFailure: () => false,
}));

// The real hook returns stable callbacks; so does this stand-in.
const { camera } = vi.hoisted(() => {
  const frame = new Blob(["x"], { type: "image/jpeg" });
  return {
    camera: {
      videoRef: { current: null },
      ready: true,
      starting: false,
      error: null,
      start: () => Promise.resolve(),
      stop: () => undefined,
      captureFrame: () => Promise.resolve(frame),
      captureBurst: () => Promise.resolve([frame]),
      sampleThumbnail: () => null,
      devices: [],
      deviceId: null,
      isInfrared: false,
      switchCamera: () => undefined,
    },
  };
});
vi.mock("../../hooks/useCamera", () => ({ frameDifference: () => Infinity, useCamera: () => camera }));

function renderKiosk() {
  return render(
    <MemoryRouter>
      <AttendanceKiosk />
    </MemoryRouter>
  );
}

describe("AttendanceKiosk", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: { local_minutes: 9 * 60, break_start: "12:00", break_end: "13:00" } });
    post.mockReset();
    useAuthStore.setState({ user: admin, kioskLocked: true, status: "ready" });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("sends one check-in at a time and locks the punch choice while it runs", async () => {
    let finish!: (v: unknown) => void;
    post.mockImplementation((url: string) => (url === "/recognition/check-in" ? new Promise((r) => (finish = r)) : Promise.resolve({ data: {} })));
    renderKiosk();
    await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/recognition/check-in", expect.any(FormData)));
    expect(screen.getByRole("button", { name: "Time in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Time out" })).toBeDisabled();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(post.mock.calls.filter(([u]) => u === "/recognition/check-in")).toHaveLength(1);
    await act(async () => finish({ data: { status: "NO_FACE" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Time in" })).toBeEnabled());
  });

  it("says plainly that a check-in was not recorded when the network fails", async () => {
    post.mockRejectedValue(new Error("Network Error"));
    renderKiosk();
    await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
    expect(await screen.findByText(CONNECTION_ERROR_TEXT)).toBeInTheDocument();
  });

  it("pauses scanning while offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    renderKiosk();
    expect(screen.getByText(/No network connection/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start scan/ })).toBeDisabled();
    await act(async () => {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(/No network connection/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start scan/ })).toBeEnabled();
  });

  it("unlocks through the server and reports a wrong password", async () => {
    post.mockRejectedValue(Object.assign(new Error("403"), { response: { status: 403, data: { error: "Wrong password", code: "WRONG_PASSWORD" } } }));
    renderKiosk();
    await userEvent.click(screen.getByRole("button", { name: "Back to admin" }));
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    expect(await screen.findByText("Wrong password. Try again.")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/auth/kiosk/unlock", { password: "nope" });
    expect(useAuthStore.getState().kioskLocked).toBe(true);
  });
});
