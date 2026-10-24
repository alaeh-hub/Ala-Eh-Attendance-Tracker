import { useCallback, useMemo, useRef, useState } from "react";
import { create } from "zustand";

/* ----------------------------------------------------------------------------------------------
 * Development-only view of what the server's face detector saw. The enrollment check and the
 * kiosk check-in return it when asked (`debug=1`), and only when the server is not in production;
 * FaceDebugOverlay draws it over the camera.
 * ------------------------------------------------------------------------------------------- */

export interface DebugFace {
  /** [left, top, right, bottom] in the pixels of the frame the server looked at. */
  box: [number, number, number, number];
  score: number;
  /** The face the server went on to use (the others were seen but ignored). */
  chosen: boolean;
  /** YuNet's five points: right eye, left eye, nose, right mouth corner, left mouth corner. */
  landmarks?: [number, number][];
}

export interface FaceDebug {
  image: { w: number; h: number };
  faces: DebugFace[];
  /** The guide oval as the server received it (fractions of the frame), and how far it widens it. */
  zone: { cx: number; cy: number; rx: number; ry: number; margin: number } | null;
  // Enrollment check
  quality?: { ok: boolean; score: number; reason: string | null };
  pose?: { ok: boolean; progress: number; reason: string | null; yaw: number | null; pitch: number | null; label: string };
  // Kiosk check-in
  status?: string;
  engine?: string | null;
  threshold?: number | null;
  score?: number | null;
  runner_up?: number | null;
  vote_ratio?: number | null;
  frame?: number;
  frames?: number;
  // Live detection (kiosk, no scan running): one frame, and why the kiosk would or would not scan it
  live?: boolean;
  ms?: number;
  reason?: string | null;
}

export const LANDMARK_NAMES = ["right eye", "left eye", "nose", "mouth R", "mouth L"] as const;
export const LANDMARK_COLORS = ["#f87171", "#60a5fa", "#facc15", "#4ade80", "#c084fc"] as const;

const STORAGE_KEY = "face_debug_on";

/**
 * Debug is for development: it is on in the Vite dev server, and on any build when the address
 * has ?debug=1. (A production server sends no debug data whatever the page asks for.)
 */
export function faceDebugAvailable(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("debug") === "1") return true;
  } catch {
    /* no window.location: not available */
  }
  return import.meta.env.DEV && import.meta.env.MODE !== "test";
}

/** What a screen needs to take part: whether debug is on, and a way to ask for and hand over readings. */
export interface FaceDebugControls {
  available: boolean;
  on: boolean;
  toggle: () => void;
  /** True when the next request should ask the server for debug data. Stable, so it is safe inside effects and callbacks. */
  wants: () => boolean;
  /** Hand over the `debug` part of a response (undefined when the server sent none). */
  report: (debug: FaceDebug | null | undefined) => void;
}

/** The latest readings. */
export interface FaceDebugReadings {
  /** The latest reading of any kind: what the shapes are drawn from. */
  data: FaceDebug | null;
  /** The latest scan result (match numbers), kept while live readings keep coming in between scans. */
  scan: FaceDebug | null;
  /** When `data` arrived (ms since the epoch). */
  at: number;
  /** The server answered but sent no debug data, for example because it runs in production mode. */
  missing: boolean;
}

const NO_READINGS: FaceDebugReadings = { data: null, scan: null, at: 0, missing: false };

/**
 * The readings live in their own store, not in the page's state: a live feed delivers several a second,
 * and only the overlay should re-render for them, not the whole kiosk or enrollment screen.
 */
export const useFaceDebugReadings = create<FaceDebugReadings>(() => NO_READINGS);

export const clearFaceDebugReadings = () => useFaceDebugReadings.setState(NO_READINGS, true);

function readStored(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function useFaceDebug(): FaceDebugControls {
  const [available] = useState(faceDebugAvailable);
  const [on, setOn] = useState(() => available && readStored());
  const onRef = useRef(on);
  onRef.current = on;

  const toggle = useCallback(() => {
    setOn((current) => {
      const next = !current;
      try {
        sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable: the choice just isn't remembered */
      }
      return next;
    });
  }, []);

  const wants = useCallback(() => available && onRef.current, [available]);

  const report = useCallback(
    (debug: FaceDebug | null | undefined) => {
      if (!available || !onRef.current) return;
      useFaceDebugReadings.setState((prev) =>
        debug
          ? { data: debug, scan: debug.status !== undefined ? debug : prev.scan, at: Date.now(), missing: false }
          : prev.missing
            ? prev
            : { ...prev, missing: true }
      );
    },
    [available]
  );

  return useMemo(() => ({ available, on, toggle, wants, report }), [available, on, toggle, wants, report]);
}
/** What the detector saw, one number per line, for the overlay's readout. */
export function detectionLines(d: FaceDebug): string[] {
  const lines: string[] = [`frame ${d.image.w}x${d.image.h}`];
  const chosen = d.faces.find((f) => f.chosen);
  lines.push(`faces ${d.faces.length}${chosen ? "" : d.faces.length ? " (none used)" : ""}`);

  const face = chosen ?? d.faces[0];
  if (face) {
    const [left, top, right, bottom] = face.box;
    const faceH = bottom - top;
    lines.push(`box ${right - left}x${faceH} px, detector ${face.score.toFixed(2)}`);
    lines.push(`face height ${Math.round((faceH / d.image.h) * 100)}% of frame`);
    if (d.zone) {
      const ovalH = 2 * d.zone.ry * d.image.h;
      lines.push(`face / oval height ${(faceH / ovalH).toFixed(2)}`);
      const fx = (left + right) / 2 / d.image.w;
      const fy = (top + bottom) / 2 / d.image.h;
      const inside = ((fx - d.zone.cx) / (d.zone.rx * d.zone.margin)) ** 2 + ((fy - d.zone.cy) / (d.zone.ry * d.zone.margin)) ** 2 <= 1;
      lines.push(`centre in zone ${inside ? "yes" : "NO"}`);
    } else {
      lines.push("no oval sent");
    }
  }

  if (d.live) lines.push(`live detection ${d.ms ?? "?"} ms`, `server: ${d.reason ?? "face ok"}`);

  if (d.pose) {
    const angle = (v: number | null) => (v === null ? "-" : v.toFixed(2));
    lines.push(`pose ${d.pose.label} ${d.pose.ok ? "ok" : "not yet"}, ${Math.round(d.pose.progress * 100)}%`);
    lines.push(`yaw ${angle(d.pose.yaw)}  pitch ${angle(d.pose.pitch)}`);
  }
  if (d.quality) lines.push(`quality ${d.quality.score.toFixed(2)} ${d.quality.ok ? "ok" : "fail"}`);
  return lines;
}

/** How a scan scored, one number per line (empty for a reading that has no scan behind it). */
export function matchLines(d: FaceDebug): string[] {
  const lines: string[] = [];
  if (d.status) {
    const n = (v: number | null | undefined) => (v === null || v === undefined ? "-" : v.toFixed(2));
    lines.push(`status ${d.status}${d.engine ? ` (${d.engine})` : ""}`);
    lines.push(`score ${n(d.score)} / threshold ${n(d.threshold)}`);
    lines.push(`runner-up ${n(d.runner_up)}  votes ${n(d.vote_ratio)}`);
    if (d.frames) lines.push(`burst ${d.frames} frames, last seen ${(d.frame ?? 0) + 1}`);
  }
  return lines;
}

/** Everything worth reading about one reading. */
export function debugLines(d: FaceDebug): string[] {
  return [...detectionLines(d), ...matchLines(d)];
}
