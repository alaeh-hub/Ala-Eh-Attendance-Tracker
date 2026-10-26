import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, maria } from "../../test/fixtures";
import { clearFaceDebugReadings } from "../../utils/faceDebug";
import FaceEnrollment from "./FaceEnrollment";

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({
  default: { get, post, delete: del },
  errorMessage: (e: any, fallback?: string) => e?.response?.data?.error ?? fallback ?? "error",
}));

// A camera that is always ready and hands out a fresh frame on every call.
// Like the real hook, the returned functions and ref are stable across renders.
const camera = vi.hoisted(() => ({
  videoRef: { current: null },
  ready: true,
  starting: false,
  error: null,
  start: () => undefined,
  stop: () => undefined,
  captureFrame: async () => new Blob([String(Math.random())], { type: "image/jpeg" }),
  devices: [],
  deviceId: null,
  isInfrared: false,
  switchCamera: () => undefined,
}));
vi.mock("../../hooks/useCamera", () => ({ useCamera: () => camera }));
vi.mock("../../components/CameraView", () => ({ default: () => <div data-testid="camera" /> }));
vi.mock("../../utils/guideZone", () => ({ guideZone: () => null }));

// Nothing can be heard in a test: record what would have been played or said.
const sound = vi.hoisted(() => ({
  chime: vi.fn(),
  say: vi.fn(),
  sayOnce: vi.fn(),
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
  preloadVoice: vi.fn(),
  useAudioUnlock: () => undefined,
  isVoiceKey: (key: string) => key.startsWith("pose."),
}));
vi.mock("../../utils/sound", () => sound);

const status = {
  user_id: maria.id,
  engine: "sface",
  sample_count: 0,
  outdated_samples: 0,
  min_required: 2,
  max_samples: 10,
  enrollment_complete: false,
  poses_captured: [] as string[],
  average_quality: null,
  has_photo: false,
  consent_recorded: true,
};

const samplePosts = () => post.mock.calls.filter(([url]) => url === "/enrollment/sample");

const renderEnrollment = () =>
  render(
    <MemoryRouter initialEntries={[`/enroll?user=${maria.id}`]}>
      <FaceEnrollment />
    </MemoryRouter>
  );

describe("Face enrollment capture", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
    Object.values(sound).forEach((fn) => (vi.isMockFunction(fn) ? fn.mockClear() : undefined));
    sessionStorage.clear();
    get.mockImplementation((url: string) => {
      if (url === `/users/${maria.id}`) return Promise.resolve({ data: maria });
      if (url === "/enrollment/poses") return Promise.resolve({ data: { poses: ["frontal", "left"] } });
      if (url === "/enrollment/status") return Promise.resolve({ data: status });
      if (url === "/departments") return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it("does not resubmit a rejected frame and does not calibrate from it", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.reject(apiError(422, { error: "Face too blurry." }));
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render(
      <MemoryRouter initialEntries={[`/enroll?user=${maria.id}`]}>
        <FaceEnrollment />
      </MemoryRouter>
    );

    await waitFor(() => expect(samplePosts()).toHaveLength(1), { timeout: 3000 });
    expect(await screen.findByText("Face too blurry.")).toBeInTheDocument();
    const rejected = samplePosts()[0][1].get("image");

    // Within the pause after a rejection nothing is resubmitted.
    await new Promise((r) => setTimeout(r, 1200));
    expect(samplePosts()).toHaveLength(1);

    // A later attempt (after fresh readiness checks) uses a NEW frame, never the rejected one.
    await waitFor(() => expect(samplePosts().length).toBeGreaterThan(1), { timeout: 4000 });
    expect(samplePosts()[1][1].get("image")).not.toBe(rejected);

    // The baseline pose angles were never saved from a frame the server refused.
    expect(sessionStorage.getItem(`enroll_calibration_${maria.id}`)).toBeNull();
  }, 10000);

  it("tells the person why a capture was refused with a banner", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.reject(apiError(422, { error: "Face too blurry." }));
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    const banner = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(banner).toHaveTextContent("Not captured");
    expect(banner).toHaveTextContent("Face too blurry.");
  }, 10000);

  it("says 'try again' once, not on every refused capture", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.reject(apiError(422, { error: "Face too blurry." }));
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    await waitFor(() => expect(samplePosts().length).toBeGreaterThan(1), { timeout: 5000 }); // refused more than once
    expect(sound.say.mock.calls.filter(([key]) => key === "retry")).toHaveLength(1);
  }, 12000);

  it("speaks each pose, and stops speaking when sound is turned off", async () => {
    post.mockImplementation(() => new Promise(() => undefined)); // nothing gets captured
    renderEnrollment();

    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("pose.frontal"));
    expect(sound.preloadVoice).toHaveBeenCalled();

    sound.stopSpeaking.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Turn sound off" }));
    expect(sound.stopSpeaking).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Turn sound on" })).toBeInTheDocument();
  });

  it("stays silent about poses when sound is off and nothing was captured", async () => {
    post.mockImplementation(() => new Promise(() => undefined));
    renderEnrollment();
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith("pose.frontal"));
    await userEvent.click(screen.getByRole("button", { name: "Turn sound off" }));
    sound.say.mockClear();

    await new Promise((r) => setTimeout(r, 600));
    expect(sound.say).not.toHaveBeenCalled();
  });

  it("says 'captured' before the next pose, after the chime", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.resolve({ data: { ...status, sample_count: 1, poses_captured: ["frontal"], quality_score: 0.9 } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    await waitFor(() => expect(sound.say).toHaveBeenCalledWith(["enroll.captured", "pose.left"], expect.any(Number)), { timeout: 3000 });
  }, 10000);

  it("says the face is already enrolled when the capture is blocked", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.reject(apiError(409, { error: "Matches another employee.", code: "DUPLICATE_FACE" }));
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    expect(await screen.findByText("Capture blocked for accuracy", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(sound.say).toHaveBeenCalledWith("enroll.blocked", expect.any(Number));
  }, 10000);

  it("says re-enrollment is needed when old samples can't be used", async () => {
    get.mockImplementation((url: string) => {
      if (url === `/users/${maria.id}`) return Promise.resolve({ data: maria });
      if (url === "/enrollment/poses") return Promise.resolve({ data: { poses: ["frontal", "left"] } });
      if (url === "/enrollment/status") return Promise.resolve({ data: { ...status, outdated_samples: 3 } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    post.mockImplementation(() => new Promise(() => undefined));
    renderEnrollment();

    expect(await screen.findByText("Re-enrollment needed")).toBeInTheDocument();
    expect(sound.say).toHaveBeenCalledWith("enroll.outdated");
    expect(sound.say).not.toHaveBeenCalledWith("pose.frontal");
  });

  it("says 'samples cleared' before the first pose again after Start over", async () => {
    get.mockImplementation((url: string) => {
      if (url === `/users/${maria.id}`) return Promise.resolve({ data: maria });
      if (url === "/enrollment/poses") return Promise.resolve({ data: { poses: ["frontal", "left"] } });
      if (url === "/enrollment/status") return Promise.resolve({ data: { ...status, sample_count: 1, poses_captured: ["frontal"] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    del.mockResolvedValue({ data: status });
    post.mockImplementation(() => new Promise(() => undefined));
    renderEnrollment();

    await userEvent.click(await screen.findByRole("button", { name: "Start over" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete samples" }));
    await waitFor(() => expect(sound.say).toHaveBeenCalledWith(["enroll.cleared", "pose.frontal"], expect.any(Number)));
  });

  describe("debug overlay (development only)", () => {
    const checkForms = () => post.mock.calls.filter(([url]) => url === "/enrollment/check").map(([, form]) => form as FormData);
    const detection = {
      image: { w: 640, h: 480 },
      faces: [{ box: [250, 140, 390, 320], score: 0.93, chosen: true, landmarks: [[280, 200], [360, 200], [320, 240], [290, 280], [350, 280]] }],
      zone: null,
      quality: { ok: true, score: 0.91, reason: null },
      pose: { ok: false, progress: 0.58, reason: "Turn more", yaw: -0.08, pitch: 0.02, label: "frontal" },
    };
    const answerChecks = (withDebug: boolean) =>
      post.mockImplementation((url: string) => {
        if (url === "/enrollment/check") return Promise.resolve({ data: { ready: false, score: 0.58, reason: "Turn more", yaw: -0.08, pitch: 0.02, ...(withDebug ? { debug: detection } : {}) } });
        return Promise.reject(new Error(`unexpected POST ${url}`));
      });
    afterEach(() => {
      window.history.pushState({}, "", "/");
      sessionStorage.clear();
      clearFaceDebugReadings();
    });

    it("asks for nothing and shows nothing in a normal address", async () => {
      answerChecks(true);
      renderEnrollment();
      await waitFor(() => expect(checkForms().length).toBeGreaterThan(0));
      expect(checkForms()[0].get("debug")).toBeNull();
      expect(screen.queryByText(/Debug · enroll/)).not.toBeInTheDocument();
    });

    it("asks the server for it with ?debug=1 and shows the pose and quality numbers", async () => {
      window.history.pushState({}, "", "/?debug=1");
      answerChecks(true);
      renderEnrollment();
      expect(await screen.findByText("pose frontal not yet, 58%")).toBeInTheDocument();
      expect(checkForms()[0].get("debug")).toBe("1");
      expect(screen.getByText("quality 0.91 ok")).toBeInTheDocument();
      expect(screen.getByText(/yaw -0\.08\s+pitch 0\.02/)).toBeInTheDocument(); // the readout has two spaces; the page text is whitespace-collapsed
      expect(screen.getByTestId("face-debug-shapes").querySelectorAll("[data-landmark]")).toHaveLength(5);
    });

    it("says when the server sends no debug data (it is in production mode)", async () => {
      window.history.pushState({}, "", "/?debug=1");
      answerChecks(false);
      renderEnrollment();
      expect(await screen.findByText(/server sent no debug data/)).toBeInTheDocument();
    });
  });
  it("shows a success banner once a pose is accepted", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.resolve({ data: { ...status, sample_count: 1, poses_captured: ["frontal"], quality_score: 0.9 } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    const banner = await screen.findByText("Captured", {}, { timeout: 3000 });
    expect(banner.parentElement).toHaveTextContent("Quality 90%");
  }, 10000);

  it("puts the controls on screen and names the current pose", async () => {
    post.mockImplementation(() => new Promise(() => undefined)); // readiness never answers: nothing gets captured
    renderEnrollment();

    expect(await screen.findByText("Look straight ahead")).toBeInTheDocument();
    // The pose list starts with the defaults and settles once the server answers.
    expect(await screen.findByText("Pose 1 of 2")).toBeInTheDocument();
    for (const name of ["Back", "Start over", "Turn sound off", "Toggle fullscreen"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Auto-capture on/ })).toHaveAttribute("aria-pressed", "true");
    // Finishing needs enough samples, so the button is not offered yet.
    expect(screen.queryByRole("button", { name: /Finish/ })).not.toBeInTheDocument();
  });

  it("waits for the employee's consent before capturing anything", async () => {
    get.mockImplementation((url: string) => {
      if (url === `/users/${maria.id}`) return Promise.resolve({ data: maria });
      if (url === "/enrollment/poses") return Promise.resolve({ data: { poses: ["frontal", "left"] } });
      if (url === "/enrollment/status") return Promise.resolve({ data: { ...status, consent_recorded: false } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample") return Promise.resolve({ data: { ...status, sample_count: 1, poses_captured: ["frontal"], quality_score: 0.9 } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderEnrollment();

    expect(await screen.findByText("Biometric consent")).toBeInTheDocument();
    expect(sound.say).toHaveBeenCalledWith("enroll.consent");
    expect(sound.say).not.toHaveBeenCalledWith("pose.frontal");
    await new Promise((r) => setTimeout(r, 1500));
    expect(samplePosts()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /They agree/ }));
    await waitFor(() => expect(samplePosts()).toHaveLength(1), { timeout: 3000 });
    expect(samplePosts()[0][1].get("consent")).toBe("true");
  }, 10000);

  it("commits calibration only after the sample is accepted", async () => {
    post.mockImplementation((url: string) => {
      if (url === "/enrollment/check") return Promise.resolve({ data: { ready: true, score: 0.95, reason: null, yaw: 3, pitch: -2 } });
      if (url === "/enrollment/sample")
        return Promise.resolve({ data: { ...status, sample_count: 1, poses_captured: ["frontal"], quality_score: 0.9 } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    render(
      <MemoryRouter initialEntries={[`/enroll?user=${maria.id}`]}>
        <FaceEnrollment />
      </MemoryRouter>
    );
    await waitFor(() => expect(samplePosts()).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem(`enroll_calibration_${maria.id}`) || "{}")).toEqual({ baselineYaw: 3, baselinePitch: -2 }));
  }, 10000);
});
