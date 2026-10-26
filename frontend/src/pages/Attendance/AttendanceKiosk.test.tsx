import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { clearFaceDebugReadings } from "../../utils/faceDebug";
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

// Nothing can be heard in a test: record what would have been played or said.
const sound = vi.hoisted(() => ({ chime: vi.fn(), say: vi.fn(), sayOnce: vi.fn(), preloadVoice: vi.fn(), stopSpeaking: vi.fn(), useAudioUnlock: () => undefined }));
vi.mock("../../utils/sound", () => sound);

const punch = (event_type: "CLOCK_IN" | "CLOCK_OUT") => ({
  id: "e1",
  user_id: "u1",
  user_name: "Maria Santos",
  event_type,
  session: "AM",
  timestamp: new Date().toISOString(),
  has_photo: false,
  is_late: false,
});

/** Opens the kiosk and presses Start scan; the server answers every check-in with `result`. */
async function scanAndGet(result: object) {
  post.mockImplementation((url: string) => Promise.resolve({ data: url === "/recognition/check-in" ? result : {} }));
  renderKiosk();
  await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
}

/** Everything said once, in order, apart from the "look at the camera" that Start scan itself speaks. */
const said = () => sound.say.mock.calls.map(([key]) => key).filter((key) => key !== "kiosk.start");
const saidOnce = () => sound.sayOnce.mock.calls.map(([key]) => key);

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

  it("says 'look at the camera' when Start scan is pressed", async () => {
    await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again." });
    expect(sound.say).toHaveBeenCalledWith("kiosk.start");
  });

  it("says 'time in, thank you' when a time in is recorded", async () => {
    await scanAndGet({ status: "MATCHED", event: punch("CLOCK_IN"), corrected: false });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.time_in", expect.any(Number)));
    expect(said()).toEqual(["kiosk.time_in"]);
  });

  it("says 'time out, thank you' when a time out is recorded", async () => {
    await scanAndGet({ status: "MATCHED", event: punch("CLOCK_OUT"), corrected: false });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.time_out", expect.any(Number)));
    expect(said()).toEqual(["kiosk.time_out"]);
  });

  it("says what was recorded, not what the button asked for, when the server changed the punch", async () => {
    await scanAndGet({ status: "MATCHED", event: punch("CLOCK_OUT"), corrected: true, correction_note: "Recorded as a time out." });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.time_out", expect.any(Number)));
    expect(said()).toEqual(["kiosk.time_out"]);
  });

  it("says 'verified' when a scan re-confirms attendance that is already recorded", async () => {
    await scanAndGet({ status: "VERIFIED", event: punch("CLOCK_IN"), user_id: "u1", user_name: "Maria Santos", reason: "Already on record." });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.verified", expect.any(Number)));
    expect(said()).toEqual(["kiosk.verified"]);
  });

  it("says 'already recorded' when the scan lands in the cooldown", async () => {
    await scanAndGet({ status: "COOLDOWN", event: punch("CLOCK_IN"), user_id: "u1", user_name: "Maria Santos", reason: "Already recorded. You can scan again in 30s." });
    expect(await screen.findByText(/Already recorded, Maria/)).toBeInTheDocument();
    expect(said()).toEqual(["kiosk.already_recorded"]);
  });

  it("asks for a blink, but not on every scan", async () => {
    await scanAndGet({ status: "LIVENESS_FAILED", first_name: "Maria", reason: "Blink to continue." });
    await waitFor(() => expect(sound.sayOnce).toHaveBeenCalledWith("kiosk.blink", expect.any(Number)));
    // It goes through sayOnce, which holds the repeats back; nothing is said directly.
    expect(said()).toEqual([]);
  });

  it("tells someone holding up a photo or screen that a live face is needed", async () => {
    await scanAndGet({ status: "SPOOF_SUSPECTED", reason: "Please show your live face." });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.live_face", expect.any(Number)));
  });

  it("says 'hold still' while the match is unsure, and gives up with an explanation after four tries", async () => {
    await scanAndGet({ status: "LOW_CONFIDENCE", reason: "Hold still." });
    await waitFor(() => expect(saidOnce()).toContain("kiosk.hold_still"));
    await waitFor(() => expect(said()).toEqual(["kiosk.cant_confirm"]), { timeout: 4000 });
  });

  it("says 'not recognized' when the face matches no one, twice in a row", async () => {
    await scanAndGet({ status: "NO_MATCH" });
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.not_recognized", expect.any(Number)), { timeout: 4000 });
  });

  it("tells the person to move closer", async () => {
    await scanAndGet({ status: "NO_FACE", reason: "Move closer so your face fills the circle." });
    await waitFor(() => expect(saidOnce()).toContain("kiosk.move_closer"));
  });

  it("tells the person to move into the circle", async () => {
    await scanAndGet({ status: "NO_FACE", reason: "Move into the circle." });
    await waitFor(() => expect(saidOnce()).toContain("kiosk.move_circle"));
  });

  it("asks for one person at a time when several faces are seen", async () => {
    await scanAndGet({ status: "NO_FACE", reason: "Multiple faces detected. Only one person should be visible." });
    await waitFor(() => expect(saidOnce()).toContain("kiosk.one_person"));
  });

  it("says nothing to an empty room", async () => {
    await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again." });
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(said()).toEqual([]);
    expect(saidOnce()).toEqual([]);
  });

  it("says 'no connection, not recorded' when the network fails", async () => {
    post.mockRejectedValue(new Error("Network Error"));
    renderKiosk();
    await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.no_connection", expect.any(Number)));
  });

  it("says 'not recorded' when the server refuses the check-in", async () => {
    post.mockRejectedValue(Object.assign(new Error("500"), { response: { status: 500, data: { error: "boom" } } }));
    renderKiosk();
    await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("kiosk.not_recorded", expect.any(Number)));
  });
  describe("debug overlay (development only)", () => {
    const checkInForms = () => post.mock.calls.filter(([url]) => url === "/recognition/check-in").map(([, form]) => form as FormData);
    const detection = {
      image: { w: 640, h: 480 },
      faces: [{ box: [250, 140, 390, 320], score: 0.93, chosen: true, landmarks: [[280, 200], [360, 200], [320, 240], [290, 280], [350, 280]] }],
      zone: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.4, margin: 1.3 },
      status: "NO_FACE",
      threshold: 0.5,
    };
    afterEach(() => {
      window.history.pushState({}, "", "/");
      sessionStorage.clear();
      clearFaceDebugReadings();
    });

    it("asks for nothing and shows nothing in a normal address", async () => {
      await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again." });
      await waitFor(() => expect(checkInForms().length).toBeGreaterThan(0));
      expect(checkInForms()[0].get("debug")).toBeNull();
      expect(screen.queryByText(/Debug · scan/)).not.toBeInTheDocument();
    });

    it("asks the server for it with ?debug=1 and shows what the detector saw", async () => {
      window.history.pushState({}, "", "/?debug=1");
      await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again.", debug: detection });
      expect(await screen.findByText("frame 640x480")).toBeInTheDocument();
      expect(checkInForms()[0].get("debug")).toBe("1");
      expect(screen.getByText("faces 1")).toBeInTheDocument();
      expect(screen.getByTestId("face-debug-shapes").querySelectorAll("[data-landmark]")).toHaveLength(5);
    });

    it("says when the server sends no debug data (it is in production mode)", async () => {
      window.history.pushState({}, "", "/?debug=1");
      await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again." });
      expect(await screen.findByText(/server sent no debug data/)).toBeInTheDocument();
    });

    describe("live preview", () => {
      const liveDetection = { ...detection, status: undefined, live: true, ms: 12, reason: null };
      const detectCalls = () => post.mock.calls.filter(([url]) => url === "/recognition/debug-detect").length;
      const answerLive = (checkIn?: () => Promise<unknown>) =>
        post.mockImplementation((url: string) => {
          if (url === "/recognition/debug-detect") return Promise.resolve({ data: { debug: liveDetection } });
          if (url === "/recognition/check-in" && checkIn) return checkIn();
          return Promise.resolve({ data: {} });
        });

      it("follows the face before Start scan is pressed", async () => {
        window.history.pushState({}, "", "/?debug=1");
        answerLive();
        renderKiosk();

        expect(await screen.findByText("live detection 12 ms")).toBeInTheDocument();
        expect(screen.getByTestId("face-debug-shapes").querySelectorAll("[data-landmark]")).toHaveLength(5);
        const frames = post.mock.calls.filter(([url]) => url === "/recognition/debug-detect").map(([, form]) => form as FormData);
        expect(frames[0].get("frame")).toBeInstanceOf(Blob);
        // nothing was scanned: only the live preview ran
        expect(post.mock.calls.some(([url]) => url === "/recognition/check-in")).toBe(false);
        // and it keeps coming
        await waitFor(() => expect(detectCalls()).toBeGreaterThan(2), { timeout: 3000 });
      });

      it("is off in a normal address", async () => {
        answerLive();
        renderKiosk();
        await act(() => new Promise((r) => setTimeout(r, 700)));
        expect(detectCalls()).toBe(0);
      });

      it("stands down while a scan request is in flight", async () => {
        window.history.pushState({}, "", "/?debug=1");
        answerLive(() => new Promise(() => undefined)); // the scan never answers
        renderKiosk();
        await screen.findByText("live detection 12 ms");

        await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
        await waitFor(() => expect(post.mock.calls.some(([url]) => url === "/recognition/check-in")).toBe(true));
        const atStart = detectCalls();
        await act(() => new Promise((r) => setTimeout(r, 800)));
        expect(detectCalls() - atStart).toBeLessThanOrEqual(1); // at most the one that was already on its way
      });

      it("keeps the last scan's numbers on screen while the live preview carries on", async () => {
        window.history.pushState({}, "", "/?debug=1");
        post.mockImplementation((url: string) => {
          if (url === "/recognition/debug-detect") return Promise.resolve({ data: { debug: liveDetection } });
          if (url === "/recognition/check-in") return Promise.resolve({ data: { status: "LOW_CONFIDENCE", reason: "Hold still.", debug: { ...detection, status: "LOW_CONFIDENCE", engine: "sface", score: 0.43, runner_up: 0.31, vote_ratio: 0.6 } } });
          return Promise.resolve({ data: {} });
        });
        renderKiosk();
        await screen.findByText("live detection 12 ms");
        await userEvent.click(screen.getByRole("button", { name: /Start scan/ }));
        await userEvent.click(await screen.findByRole("button", { name: /Stop/ })); // stop scanning; the live preview resumes

        await waitFor(() => expect(screen.getByText("live detection 12 ms")).toBeInTheDocument());
        expect(await screen.findByText("last scan")).toBeInTheDocument();
        expect(screen.getByText("score 0.43 / threshold 0.50")).toBeInTheDocument();
      });

      it("stops once hidden", async () => {
        window.history.pushState({}, "", "/?debug=1");
        answerLive();
        renderKiosk();
        await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
        const afterHide = detectCalls();
        await act(() => new Promise((r) => setTimeout(r, 800)));
        expect(detectCalls() - afterHide).toBeLessThanOrEqual(1);
      });
    });
    it("stops asking once hidden", async () => {
      window.history.pushState({}, "", "/?debug=1");
      await scanAndGet({ status: "NO_FACE", reason: "No face detected. Move into frame and try again.", debug: detection });
      await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
      const before = checkInForms().length;
      await waitFor(() => expect(checkInForms().length).toBeGreaterThan(before), { timeout: 3000 });
      expect(checkInForms()[checkInForms().length - 1].get("debug")).toBeNull();
    });
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
