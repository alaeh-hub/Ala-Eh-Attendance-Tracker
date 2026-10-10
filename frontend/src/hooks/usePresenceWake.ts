import { useEffect, useRef } from "react";

/**
 * Polls `check()` ("is someone standing at the kiosk?") while `enabled`, and calls `onWake()`
 * once a person has been seen on consecutive checks.
 *
 * Two safeguards keep the screen from flickering:
 *  - it needs `needed` positive checks in a row, so one noisy frame does not wake it;
 *  - it only wakes for someone who *arrives*: if a person is already standing there when the
 *    idle screen comes up (they walked up and stared without touching anything), it waits until
 *    the spot has been empty at least once. Otherwise it would wake, time out, and wake again
 *    every minute for as long as they stood there.
 *
 * A failed check (server unreachable) is "no information": it neither wakes nor counts as empty.
 */
export function usePresenceWake({
  enabled,
  check,
  onWake,
  intervalMs = 1000,
  needed = 2,
}: {
  enabled: boolean;
  check: () => Promise<boolean>;
  onWake: () => void;
  intervalMs?: number;
  needed?: number;
}) {
  const checkRef = useRef(check);
  const wakeRef = useRef(onWake);
  checkRef.current = check;
  wakeRef.current = onWake;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sawEmpty = false;
    let streak = 0;
    let timer: ReturnType<typeof setTimeout>;

    const loop = async () => {
      let present: boolean | null = null;
      try {
        present = await checkRef.current();
      } catch {
        present = null;
      }
      if (cancelled) return;
      if (present === false) {
        sawEmpty = true;
        streak = 0;
      } else if (present === true) {
        if (sawEmpty && ++streak >= needed) {
          wakeRef.current();
          return;
        }
      } else {
        streak = 0;
      }
      timer = setTimeout(loop, intervalMs);
    };

    timer = setTimeout(loop, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, needed]);
}
