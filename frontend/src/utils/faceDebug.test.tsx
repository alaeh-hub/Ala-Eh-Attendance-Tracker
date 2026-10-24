import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FaceDebug, clearFaceDebugReadings, debugLines, detectionLines, faceDebugAvailable, matchLines, useFaceDebug, useFaceDebugReadings } from "./faceDebug";

const scan: FaceDebug = {
  image: { w: 640, h: 480 },
  faces: [{ box: [250, 140, 390, 320], score: 0.93, chosen: true, landmarks: [[280, 200], [360, 200], [320, 240], [290, 280], [350, 280]] }],
  zone: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.4, margin: 1.3 },
  status: "LOW_CONFIDENCE",
  engine: "sface",
  threshold: 0.5,
  score: 0.43,
  runner_up: 0.31,
  vote_ratio: 0.6,
  frame: 4,
  frames: 8,
};

const live: FaceDebug = { image: scan.image, faces: scan.faces, zone: scan.zone, live: true, ms: 12, reason: null, engine: "sface" };

const goTo = (url: string) => window.history.pushState({}, "", url);
/** The latest readings: they live in a store, not in the hook's result. */
const readings = () => useFaceDebugReadings.getState();

beforeEach(() => {
  sessionStorage.clear();
  clearFaceDebugReadings();
});
afterEach(() => {
  goTo("/");
  sessionStorage.clear();
  clearFaceDebugReadings();
});

describe("faceDebugAvailable", () => {
  it("is off by default in tests and in a normal address", () => {
    expect(faceDebugAvailable()).toBe(false);
  });

  it("is switched on by ?debug=1, and only by 1", () => {
    goTo("/kiosk?debug=1");
    expect(faceDebugAvailable()).toBe(true);
    goTo("/kiosk?debug=0");
    expect(faceDebugAvailable()).toBe(false);
    goTo("/kiosk?debug=true");
    expect(faceDebugAvailable()).toBe(false);
  });
});

describe("useFaceDebug", () => {
  it("asks for nothing and ignores whatever arrives while unavailable", () => {
    const { result } = renderHook(() => useFaceDebug());
    expect(result.current.available).toBe(false);
    expect(result.current.wants()).toBe(false);
    act(() => result.current.report(scan));
    expect(readings().data).toBeNull();
  });

  it("asks for debug data and keeps the latest answer when available", () => {
    goTo("/?debug=1");
    const { result } = renderHook(() => useFaceDebug());
    expect(result.current.on).toBe(true);
    expect(result.current.wants()).toBe(true);

    act(() => result.current.report(scan));
    expect(readings().data).toEqual(scan);
    expect(readings().missing).toBe(false);
    expect(Date.now() - readings().at).toBeLessThan(1000);
  });

  it("notes when the server answered without debug data, until some arrives", () => {
    goTo("/?debug=1");
    const { result } = renderHook(() => useFaceDebug());
    act(() => result.current.report(undefined));
    expect(readings().missing).toBe(true);
    expect(readings().data).toBeNull();

    act(() => result.current.report(scan));
    expect(readings().missing).toBe(false);
    expect(readings().data).toEqual(scan);
  });

  it("stops asking while hidden, and remembers the choice for the session", () => {
    goTo("/?debug=1");
    const first = renderHook(() => useFaceDebug());
    act(() => first.result.current.toggle());
    expect(first.result.current.on).toBe(false);
    expect(first.result.current.wants()).toBe(false);
    act(() => first.result.current.report(scan));
    expect(readings().data).toBeNull(); // hidden: nothing is kept
    first.unmount();

    const second = renderHook(() => useFaceDebug()); // e.g. after moving from enrollment to the kiosk
    expect(second.result.current.on).toBe(false);
    act(() => second.result.current.toggle());
    expect(second.result.current.on).toBe(true);
    expect(second.result.current.wants()).toBe(true);
  });

  it("hands over readings without re-rendering the screen that uses the hook", () => {
    goTo("/?debug=1");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useFaceDebug();
    });
    const before = renders;
    for (let i = 0; i < 5; i++) act(() => result.current.report({ ...scan, ms: i }));
    expect(renders).toBe(before); // only the overlay, which subscribes to the store, re-renders for a live feed
    expect(readings().data).toMatchObject({ ms: 4 });
  });
  it("keeps wants and report stable, so they can sit in effect and callback dependencies", () => {
    goTo("/?debug=1");
    const { result, rerender } = renderHook(() => useFaceDebug());
    const { wants, report, toggle } = result.current;
    act(() => result.current.report(scan));
    rerender();
    expect(result.current.wants).toBe(wants);
    expect(result.current.report).toBe(report);
    expect(result.current.toggle).toBe(toggle);
  });
});

describe("useFaceDebug with live readings", () => {
  it("keeps the last scan's numbers while live readings keep coming in", () => {
    goTo("/?debug=1");
    const { result } = renderHook(() => useFaceDebug());
    act(() => result.current.report(scan));
    expect(readings().scan).toEqual(scan);

    act(() => result.current.report(live));
    expect(readings().data).toEqual(live); // the shapes follow the newest reading
    expect(readings().scan).toEqual(scan); // the match numbers stay until another scan answers

    const later = { ...scan, score: 0.61 };
    act(() => result.current.report(later));
    expect(readings().scan).toEqual(later);
  });

  it("has no scan result until a scan has answered", () => {
    goTo("/?debug=1");
    const { result } = renderHook(() => useFaceDebug());
    act(() => result.current.report(live));
    expect(readings().data).toEqual(live);
    expect(readings().scan).toBeNull();
  });

  it("does not treat an enrollment reading as a scan result", () => {
    goTo("/?debug=1");
    const { result } = renderHook(() => useFaceDebug());
    act(() => result.current.report({ image: scan.image, faces: scan.faces, zone: null, quality: { ok: true, score: 0.9, reason: null } }));
    expect(readings().scan).toBeNull();
  });
});
describe("debugLines", () => {
  it("reads out the detection and how it sits in the oval", () => {
    const lines = debugLines(scan);
    expect(lines).toContain("frame 640x480");
    expect(lines).toContain("faces 1");
    expect(lines).toContain("box 140x180 px, detector 0.93");
    expect(lines).toContain("face height 38% of frame");
    expect(lines).toContain("face / oval height 0.47"); // 180 / (2 x 0.4 x 480)
    expect(lines).toContain("centre in zone yes");
  });

  it("flags a face that is outside the zone the server accepts", () => {
    const lines = debugLines({ ...scan, faces: [{ ...scan.faces[0], box: [10, 10, 90, 120] }] });
    expect(lines).toContain("centre in zone NO");
  });

  it("says so when no oval was sent", () => {
    expect(debugLines({ ...scan, zone: null })).toContain("no oval sent");
  });

  it("reads out the kiosk's match numbers", () => {
    const lines = debugLines(scan);
    expect(lines).toContain("status LOW_CONFIDENCE (sface)");
    expect(lines).toContain("score 0.43 / threshold 0.50");
    expect(lines).toContain("runner-up 0.31  votes 0.60");
    expect(lines).toContain("burst 8 frames, last seen 5");
  });

  it("reads out the enrollment check's pose and quality", () => {
    const enroll: FaceDebug = {
      image: scan.image,
      faces: scan.faces,
      zone: scan.zone,
      quality: { ok: true, score: 0.91, reason: null },
      pose: { ok: false, progress: 0.58, reason: "Turn more", yaw: -0.08, pitch: 0.02, label: "right" },
    };
    const lines = debugLines(enroll);
    expect(lines).toContain("pose right not yet, 58%");
    expect(lines).toContain("yaw -0.08  pitch 0.02");
    expect(lines).toContain("quality 0.91 ok");
    expect(lines.some((l) => l.startsWith("status"))).toBe(false);
  });

  it("splits what was seen from how a scan scored", () => {
    expect(detectionLines(scan).some((l) => l.startsWith("status"))).toBe(false);
    expect(matchLines(scan)).toEqual(["status LOW_CONFIDENCE (sface)", "score 0.43 / threshold 0.50", "runner-up 0.31  votes 0.60", "burst 8 frames, last seen 5"]);
    expect(debugLines(scan)).toEqual([...detectionLines(scan), ...matchLines(scan)]);
  });

  it("reads out a live detection: how long it took and whether a scan would go ahead", () => {
    expect(detectionLines(live)).toEqual(expect.arrayContaining(["live detection 12 ms", "server: face ok"]));
    expect(matchLines(live)).toEqual([]);
    expect(detectionLines({ ...live, reason: "Move into the circle." })).toContain("server: Move into the circle.");
  });
  it("copes with no face, and with faces that were all ignored", () => {
    expect(debugLines({ ...scan, faces: [], status: undefined })).toContain("faces 0");
    const ignored = debugLines({ ...scan, faces: [{ ...scan.faces[0], chosen: false }] });
    expect(ignored).toContain("faces 1 (none used)");
  });

  it("shows missing angles as a dash", () => {
    const lines = debugLines({ image: scan.image, faces: [], zone: null, pose: { ok: true, progress: 1, reason: null, yaw: null, pitch: null, label: "frontal" } });
    expect(lines).toContain("yaw -  pitch -");
  });
});
