/** The guided poses, the timings of the capture screen, and the calibration kept between poses. */

export const POSES: Record<string, { title: string; hint: string; arrow?: string }> = {
  frontal: { title: "Look straight ahead", hint: "Face the camera, neutral expression" },
  left: { title: "Turn slightly left", hint: "About 20°, keep eyes on screen", arrow: "←" },
  right: { title: "Turn slightly right", hint: "About 20°, keep eyes on screen", arrow: "→" },
  up: { title: "Tilt chin up a little", hint: "Small movement is enough", arrow: "↑" },
  down: { title: "Tilt chin down a little", hint: "Small movement is enough", arrow: "↓" },
  frontal_2: { title: "Straight ahead, smile", hint: "A natural smile helps with expression changes" },
};
export const AUTO_CAPTURE_INTERVAL_MS = 700;
/** After a rejected capture, wait this long before readiness (and so auto-capture) resumes. */
export const REJECT_PAUSE_MS = 1500;
// How long a banner stays up: a success is a quick confirmation, anything else has to be read.
export const SUCCESS_NOTICE_MS = 1600;
export const NOTICE_MS = 4500;
// A capture that keeps being refused would otherwise repeat "try again" every couple of seconds.
export const RETRY_VOICE_GAP_MS = 8000;
// The spoken confirmation starts once the two-note chime has finished, so they don't talk over each other.
export const VOICE_AFTER_CHIME_MS = 400;
// "Captured." / "Samples cleared." is spoken in front of the next pose, if that pose comes up within this long.
export const LEAD_IN_MS = 3000;

export type Step = 1 | 2 | 3;

/** What the capture screen tells the person being enrolled (a banner, plus a chime). */
export type Notice = { tone: "success" | "warn" | "error"; title: string; text?: string };

export type Calibration = { baselineYaw?: number; baselinePitch?: number; leftYaw?: number; upPitch?: number };
const calibrationKey = (userId: string) => `enroll_calibration_${userId}`;

export function loadCalibration(userId: string): Calibration {
  try {
    return JSON.parse(sessionStorage.getItem(calibrationKey(userId)) || "{}") as Calibration;
  } catch {
    return {};
  }
}

export function saveCalibration(userId: string, cal: Calibration | null) {
  try {
    if (cal) sessionStorage.setItem(calibrationKey(userId), JSON.stringify(cal));
    else sessionStorage.removeItem(calibrationKey(userId));
  } catch {
    /* storage unavailable: calibration just won't survive a refresh */
  }
}
