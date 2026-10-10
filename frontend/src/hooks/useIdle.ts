import { useEffect, useRef, useState } from "react";

/** Dispatched on `window` to wake an idle screen without any touch (the kiosk does it when it sees a face). */
export const WAKE_EVENT = "app:wake";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "wheel", WAKE_EVENT] as const;

/**
 * True once `timeoutMs` has passed with no mouse/keyboard/touch activity
 * anywhere in the window. Any activity resets the timer. State only
 * changes at the idle/active transition (not on every mousemove), so this
 * doesn't cause a re-render storm while the user is working.
 *
 * While `paused` (e.g. the kiosk is mid-scan) it never reports idle, and when
 * it un-pauses the full timeout starts again from that moment.
 */
export function useIdle(timeoutMs: number, paused = false): boolean {
  const [idle, setIdle] = useState(false);
  const idleRef = useRef(false);

  useEffect(() => {
    if (paused) {
      idleRef.current = false;
      setIdle(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;

    const goIdle = () => {
      idleRef.current = true;
      setIdle(true);
    };

    const reset = () => {
      if (idleRef.current) {
        idleRef.current = false;
        setIdle(false);
      }
      clearTimeout(timer);
      timer = setTimeout(goIdle, timeoutMs);
    };

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [timeoutMs, paused]);

  return idle;
}
