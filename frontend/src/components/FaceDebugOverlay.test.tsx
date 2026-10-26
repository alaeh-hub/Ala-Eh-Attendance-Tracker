import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FaceDebug, type FaceDebugControls, type FaceDebugReadings, clearFaceDebugReadings, useFaceDebugReadings } from "../utils/faceDebug";
import FaceDebugOverlay from "./FaceDebugOverlay";

const data: FaceDebug = {
  image: { w: 1280, h: 720 },
  faces: [
    { box: [500, 200, 700, 480], score: 0.93, chosen: true, landmarks: [[550, 300], [650, 300], [600, 350], [560, 420], [640, 420]] },
    { box: [1100, 20, 1200, 150], score: 0.7, chosen: false },
  ],
  zone: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.4, margin: 1.3 },
  status: "NO_FACE",
  threshold: 0.5,
};

/** The overlay takes its controls as props and its readings from the store; this sets up both from one set of overrides. */
function state(overrides: Partial<FaceDebugControls & FaceDebugReadings> = {}): FaceDebugControls {
  const { data: reading = data, scan = null, at = Date.now(), missing = false, ...controls } = overrides;
  act(() => useFaceDebugReadings.setState({ data: reading, scan, at, missing }, true));
  return { available: true, on: true, toggle: vi.fn(), wants: () => true, report: vi.fn(), ...controls };
}

afterEach(() => clearFaceDebugReadings());

const shapes = () => screen.queryByTestId("face-debug-shapes");

describe("FaceDebugOverlay", () => {
  it("draws nothing at all when debug is not available (production)", () => {
    const { container } = render(<FaceDebugOverlay debug={state({ available: false })} kind="scan" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws every face box, the landmarks and both ovals, in the frame's own coordinates", () => {
    render(<FaceDebugOverlay debug={state()} kind="scan" />);
    const svg = shapes()!;
    expect(svg).toHaveAttribute("viewBox", "0 0 1280 720");
    expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid slice"); // crops the frame the way the video's object-cover does
    expect(svg).toHaveClass("-scale-x-100"); // mirrored like the video
    expect(svg.querySelectorAll("rect")).toHaveLength(2);
    expect(svg.querySelectorAll("[data-landmark]")).toHaveLength(5);
    const ovals = svg.querySelectorAll("ellipse");
    expect(ovals).toHaveLength(2);
    // the drawn oval, then the wider area the server accepts
    expect(ovals[0]).toHaveAttribute("rx", String(0.2 * 1280));
    expect(ovals[0]).toHaveAttribute("ry", String(0.4 * 720));
    expect(ovals[1]).toHaveAttribute("rx", String(0.2 * 1.3 * 1280));
  });

  it("draws the jawline and a chin dot when the server fitted them", () => {
    const jaw: [number, number][] = Array.from({ length: 17 }, (_, i) => [520 + i * 10, 380 + Math.abs(8 - i) * -5] as [number, number]);
    const withJaw: FaceDebug = { ...data, faces: [{ ...data.faces[0], jaw, chin: [600, 460], forehead: [600, 150] }, data.faces[1]] };
    render(<FaceDebugOverlay debug={state({ data: withJaw })} kind="enroll" />);
    expect(shapes()!.querySelectorAll("polyline")).toHaveLength(2) // the jawline and its shadow;
    expect(screen.getByTestId("face-debug-chin").style.transform).toBe("translate(600px, 460px)");
    expect(screen.getByTestId("face-debug-forehead").style.transform).toBe("translate(600px, 150px)");
    expect(screen.getByText("chin / jaw")).toBeInTheDocument();
  });

  it("marks the face that was used differently from the ones that were ignored", () => {
    render(<FaceDebugOverlay debug={state()} kind="scan" />);
    const [used, ignored] = Array.from(shapes()!.querySelectorAll("rect"));
    expect(used).not.toHaveAttribute("stroke-dasharray");
    expect(used.getAttribute("stroke")).not.toBe(ignored.getAttribute("stroke"));
    expect(ignored).toHaveAttribute("stroke-dasharray");
  });

  it("follows the store: a new reading moves the shapes without the screen passing anything down", () => {
    render(<FaceDebugOverlay debug={state()} kind="scan" />);
    expect(shapes()!.querySelectorAll("rect")).toHaveLength(2);

    act(() => useFaceDebugReadings.setState({ data: { ...data, faces: [data.faces[0]] }, at: Date.now() }));
    expect(shapes()!.querySelectorAll("rect")).toHaveLength(1);
  });
  it("draws no oval when the server was sent none", () => {
    render(<FaceDebugOverlay debug={state({ data: { ...data, zone: null } })} kind="scan" />);
    expect(shapes()!.querySelectorAll("ellipse")).toHaveLength(0);
  });

  it("shows the readout and names which screen it is on", () => {
    const { rerender } = render(<FaceDebugOverlay debug={state()} kind="scan" />);
    expect(screen.getByText(/Debug · scan/)).toBeInTheDocument();
    expect(screen.getByText("frame 1280x720")).toBeInTheDocument();
    expect(screen.getByText(/age 0\.\ds/)).toBeInTheDocument();
    rerender(<FaceDebugOverlay debug={state()} kind="enroll" />);
    expect(screen.getByText(/Debug · enroll/)).toBeInTheDocument();
  });

  it("fades a reading the camera has moved on from", () => {
    render(<FaceDebugOverlay debug={state({ at: Date.now() - 5000 })} kind="scan" />);
    expect(shapes()).toHaveStyle({ opacity: "0.3" });
    expect(screen.getByText(/stale/)).toBeInTheDocument();
  });

  it("shows the last scan's numbers under a live reading, and not under a scan's own", () => {
    const scanReading: FaceDebug = { ...data, status: "LOW_CONFIDENCE", engine: "sface", threshold: 0.5, score: 0.43, runner_up: 0.31, vote_ratio: 0.6 };
    const liveReading: FaceDebug = { ...data, status: undefined, live: true, ms: 14, reason: null };

    const { rerender } = render(<FaceDebugOverlay debug={state({ data: liveReading, scan: scanReading })} kind="scan" />);
    expect(screen.getByText("live detection 14 ms")).toBeInTheDocument();
    expect(screen.getByText("last scan")).toBeInTheDocument();
    expect(screen.getByText("score 0.43 / threshold 0.50")).toBeInTheDocument();

    // the scan's own reading already includes its numbers; they are not shown twice
    rerender(<FaceDebugOverlay debug={state({ data: scanReading, scan: scanReading })} kind="scan" />);
    expect(screen.queryByText("last scan")).not.toBeInTheDocument();
    expect(screen.getAllByText("score 0.43 / threshold 0.50")).toHaveLength(1);

    // a live reading before any scan has nothing to add
    rerender(<FaceDebugOverlay debug={state({ data: liveReading, scan: null })} kind="scan" />);
    expect(screen.queryByText("last scan")).not.toBeInTheDocument();
  });

  it("glides each box and landmark to its new place instead of jumping", () => {
    render(<FaceDebugOverlay debug={state()} kind="scan" />);
    const [box] = Array.from(shapes()!.querySelectorAll("rect"));
    expect(box.style.transform).toBe("translate(500px, 200px)");
    expect(box.style.transition).toContain("transform");
    const [firstLandmark] = Array.from(shapes()!.querySelectorAll<SVGGElement>("[data-landmark]"));
    expect(firstLandmark.style.transform).toBe("translate(550px, 300px)");
    expect(firstLandmark.style.transition).toContain("transform");
  });

  it("flags a live reading the kiosk would refuse", () => {
    render(<FaceDebugOverlay debug={state({ data: { ...data, live: true, ms: 9, reason: "Move into the circle." } })} kind="scan" />);
    expect(screen.getByText("server: Move into the circle.")).toHaveClass("text-orange-300");
  });
  it("hides the shapes but keeps the toggle when switched off", async () => {
    const toggle = vi.fn();
    render(<FaceDebugOverlay debug={state({ on: false, toggle })} kind="scan" />);
    expect(shapes()).toBeNull();
    expect(screen.queryByText("frame 1280x720")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("hides with the Hide button", async () => {
    const toggle = vi.fn();
    render(<FaceDebugOverlay debug={state({ toggle })} kind="enroll" />);
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("waits for the first reading, and says when the server isn't sending any", () => {
    const { rerender } = render(<FaceDebugOverlay debug={state({ data: null })} kind="scan" />);
    expect(screen.getByText(/Waiting for the first scan/)).toBeInTheDocument();
    expect(shapes()).toBeNull();

    rerender(<FaceDebugOverlay debug={state({ data: null })} kind="enroll" />);
    expect(screen.getByText(/Waiting for the first check/)).toBeInTheDocument();

    rerender(<FaceDebugOverlay debug={state({ data: null, missing: true })} kind="scan" />);
    expect(screen.getByText(/server sent no debug data/)).toBeInTheDocument();
  });

  it("draws a detector without landmarks (the dlib engine) as a box only", () => {
    render(<FaceDebugOverlay debug={state({ data: { ...data, faces: [{ box: [500, 200, 700, 480], score: 0.9, chosen: true }] } })} kind="scan" />);
    expect(shapes()!.querySelectorAll("rect")).toHaveLength(1);
    expect(shapes()!.querySelectorAll("[data-landmark]")).toHaveLength(0);
  });
});
