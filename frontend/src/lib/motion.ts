/**
 * Whether decorative motion should run. Off for people who ask for reduced motion, and off under jsdom, where tests assert on
 * the settled page and must never see an element half-way through an entrance.
 */
export function motionOK(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (/jsdom/i.test(navigator.userAgent)) return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Strong ease-out: quick to start, long soft landing. Same curve as --ease-out in tokens.css. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
