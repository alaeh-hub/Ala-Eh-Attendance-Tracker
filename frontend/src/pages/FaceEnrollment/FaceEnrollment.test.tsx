import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, maria } from "../../test/fixtures";
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

describe("Face enrollment capture", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
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
