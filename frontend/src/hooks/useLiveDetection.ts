import { RefObject, useEffect } from "react";
import api from "../services/api";
import type { FaceDebug } from "../utils/faceDebug";
import { guideZone } from "../utils/guideZone";

/**
 * Up to about eight readings a second. A reading costs the server roughly 15-20 ms and a round trip is
 * about 40 ms, so this is comfortably within what it can do, and well inside its rate limit.
 */
export const LIVE_INTERVAL_MS = 120;
const AFTER_ERROR_MS = 1000;
const AFTER_RATE_LIMIT_MS = 2000;
const AFTER_NOT_FOUND_MS = 5000;

/**
 * Development only: while the debug view is on, sends a small frame to the server every few hundred
 * milliseconds and reports what its detector saw, so the overlay follows a face continuously, even
 * with no scan running. It asks the server's own detector, so what it draws is what a scan would
 * see. Switch it off (enabled = false) while a scan is running or the screen is idle.
 *
 * A server in production mode answers 404; that is reported as "no debug data" and retried only
 * rarely.
 */
export function useLiveDetection({
  enabled,
  captureFrame,
  videoRef,
  ovalRef,
  report,
  intervalMs = LIVE_INTERVAL_MS,
}: {
  enabled: boolean;
  captureFrame: (quality?: number, maxWidth?: number) => Promise<Blob | null>;
  videoRef: RefObject<HTMLVideoElement>;
  ovalRef: RefObject<HTMLElement>;
  report: (debug: FaceDebug | null | undefined) => void;
  intervalMs?: number;
}) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // One request at a time: the next frame is only taken once the last answer is back.
    const tick = async () => {
      const started = performance.now();
      let pause: number | null = null; // null = keep the normal rhythm
      try {
        const frame = await captureFrame(0.6, 480);
        if (frame && !cancelled) {
          const form = new FormData();
          form.append("frame", frame, "live.jpg");
          const zone = guideZone(videoRef.current, ovalRef.current);
          if (zone) form.append("zone", JSON.stringify(zone));
          const res = await api.post<{ debug: FaceDebug }>("/recognition/debug-detect", form);
          if (!cancelled) report(res.data.debug);
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
          if (!cancelled) report(undefined);
          pause = AFTER_NOT_FOUND_MS;
        } else {
          pause = status === 429 ? AFTER_RATE_LIMIT_MS : AFTER_ERROR_MS;
        }
      }
      if (!cancelled) timer = setTimeout(tick, pause ?? Math.max(0, intervalMs - (performance.now() - started)));
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, captureFrame, videoRef, ovalRef, report, intervalMs]);
}
