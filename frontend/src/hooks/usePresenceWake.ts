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
 *
 * Polling backs off while the spot stays empty: it starts at `intervalMs` and
 * grows by `backoff` per empty check up to `maxIntervalMs` (default: no backoff),
 * snapping back as soon as someone is seen.
 */
export function usePresenceWake({
  enabled,
  check,
  onWake,
  intervalMs = 1000,
  maxIntervalMs = intervalMs,
  backoff = 1.5,
  needed = 2,
}: {
  enabled: boolean;
  check: () => Promise<boolean>;
  onWake: () => void;
  intervalMs?: number;
  maxIntervalMs?: number;
  backoff?: number;
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
    let empties = 0;
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
        empties += 1;
      } else if (present === true) {
        empties = 0;
        if (sawEmpty && ++streak >= needed) {
          wakeRef.current();
          return;
        }
      } else {
        streak = 0;
      }
      timer = setTimeout(loop, Math.min(maxIntervalMs, intervalMs * backoff ** empties));
    };

    timer = setTimeout(loop, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, maxIntervalMs, backoff, needed]);
}
