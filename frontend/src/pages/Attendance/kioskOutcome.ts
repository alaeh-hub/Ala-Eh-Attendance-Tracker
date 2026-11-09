import type { CameraTone } from "../../components/CameraView";
import type { AttendanceEvent, CheckInResult } from "../../types";
import type { VoiceKey } from "../../utils/sound";

export const SUCCESS_HOLD_MS = 4000;
// A punch that didn't match the button pressed needs longer on screen —
// the employee has to actually read why it was changed.
export const CORRECTED_HOLD_MS = 7000;
export const NOTICE_HOLD_MS = 4000;
// The spoken confirmation starts once the two-note chime has finished, so they don't talk over each other.
export const VOICE_AFTER_CHIME_MS = 400;
// Prompts that come back on every scan ("please blink", "hold still") are spoken at most this often.
export const PROMPT_VOICE_GAP_MS = 6000;

// Inconclusive reads in a row before the kiosk gives up and says so.
const UNSURE_LIMIT = 4;
const NO_MATCH_LIMIT = 2;

/** What the kiosk is showing right now. */
export type Phase =
  | { kind: "idle" }
  | { kind: "prompt"; text: string; tone: CameraTone }
  | { kind: "success"; event: AttendanceEvent; note?: string; reverifySeconds?: number }
  | { kind: "notice"; title: string; text: string; tone: "warn" | "error"; event?: AttendanceEvent; name?: string; userId?: string; hasPhoto?: boolean };

/** One sound the kiosk makes, in order. */
export type Cue = { chime: boolean } | { say: VoiceKey; delay?: number } | { sayOnce: VoiceKey; gap: number };

/** Consecutive scans that couldn't settle on an answer; reset by anything conclusive. */
export type Streak = { noMatch: number; unsure: number };
export const NO_STREAK: Streak = { noMatch: 0, unsure: 0 };

export type Outcome = {
  cues: Cue[];
  phase: Phase;
  /** Set when this scan is finished: the phase stays up this long and scanning stops until Start is pressed again. */
  holdMs?: number;
  /** How long to wait before the next automatic scan. */
  waitMs: number;
  /** A punch was recorded: the employee's selection is spent. */
  recordedEvent?: AttendanceEvent;
};

const firstName = (name?: string) => name?.split(" ")[0] ?? "";

function held(phase: Phase, holdMs: number, cues: Cue[], extra: Partial<Outcome> = {}): Outcome {
  return { cues, phase, holdMs, waitMs: holdMs, ...extra };
}

function notice(title: string, text: string, tone: "warn" | "error", extra: Partial<Extract<Phase, { kind: "notice" }>> = {}): Phase {
  return { kind: "notice", title, text, tone, ...extra };
}

/**
 * Turns the server's answer to one scan into what the kiosk does next.
 * Pure: the only memory is the `streak` it is given and hands back.
 */
export function interpretCheckIn(data: CheckInResult, streak: Streak): { outcome: Outcome; streak: Streak } {
  const conclusive = (outcome: Outcome) => ({ outcome, streak: NO_STREAK });
  const identity = { event: data.event, name: data.user_name, userId: data.user_id, hasPhoto: data.has_photo };

  switch (data.status) {
    case "MATCHED": {
      const event = data.event!;
      const ms = data.corrected ? CORRECTED_HOLD_MS : SUCCESS_HOLD_MS;
      // Say what was actually recorded: the server may have overruled the button that was pressed.
      return conclusive(held(
        { kind: "success", event, note: data.correction_note ?? undefined, reverifySeconds: data.reverify_seconds },
        ms,
        [{ chime: true }, { say: event.event_type === "CLOCK_IN" ? "kiosk.time_in" : "kiosk.time_out", delay: VOICE_AFTER_CHIME_MS }],
        { recordedEvent: event },
      ));
    }
    case "COOLDOWN":
      return conclusive(held(
        notice(`Already recorded, ${firstName(data.user_name)}`, data.reason || "", "warn", identity),
        NOTICE_HOLD_MS,
        [{ say: "kiosk.already_recorded" }],
      ));
    case "VERIFIED":
      return conclusive(held(
        notice(`Verified, ${firstName(data.user_name)}`, data.reason || "", "warn", identity),
        NOTICE_HOLD_MS,
        [{ chime: true }, { say: "kiosk.verified", delay: VOICE_AFTER_CHIME_MS }],
      ));
    case "LIVENESS_FAILED":
      return {
        outcome: {
          cues: [{ sayOnce: "kiosk.blink", gap: PROMPT_VOICE_GAP_MS }],
          phase: { kind: "prompt", text: `Hi ${data.first_name ?? "there"}! Please blink 👀`, tone: "scanning" },
          waitMs: 0,
        },
        streak,
      };
    case "SPOOF_SUSPECTED":
      return conclusive(held(
        notice("Live face required", data.reason || "Photos and screens are not accepted. Face the camera directly.", "error"),
        NOTICE_HOLD_MS,
        [{ chime: false }, { say: "kiosk.live_face", delay: VOICE_AFTER_CHIME_MS }],
      ));
    case "LOW_CONFIDENCE":
    case "AMBIGUOUS_MATCH": {
      const unsure = streak.unsure + 1;
      if (unsure >= UNSURE_LIMIT) {
        return {
          outcome: held(
            notice("Can't confirm who you are", data.reason || "Face the camera directly in good light, remove sunglasses or mask, and hold still.", "warn"),
            NOTICE_HOLD_MS,
            [{ say: "kiosk.cant_confirm" }],
          ),
          streak: { ...streak, unsure: 0 },
        };
      }
      return {
        outcome: {
          cues: [{ sayOnce: "kiosk.hold_still", gap: PROMPT_VOICE_GAP_MS }],
          phase: { kind: "prompt", text: data.reason || "Hold still and look at the camera", tone: "scanning" },
          waitMs: 150,
        },
        streak: { ...streak, unsure },
      };
    }
    case "NO_MATCH": {
      const noMatch = streak.noMatch + 1;
      if (noMatch >= NO_MATCH_LIMIT) {
        return {
          outcome: held(
            notice("Not recognized", "You don't appear to be enrolled. Please see an administrator.", "error"),
            NOTICE_HOLD_MS,
            [{ chime: false }, { say: "kiosk.not_recognized", delay: VOICE_AFTER_CHIME_MS }],
          ),
          streak: { ...streak, noMatch: 0 },
        };
      }
      return {
        outcome: { cues: [], phase: { kind: "prompt", text: "Checking… look at the camera", tone: "scanning" }, waitMs: 150 },
        streak: { ...streak, noMatch },
      };
    }
    case "NO_FACE":
    default: {
      // Nothing is said when there is simply nobody there; only when someone needs to move or be alone.
      const reason = data.reason;
      const cues: Cue[] = [];
      let phase: Phase = { kind: "idle" };
      if (reason?.startsWith("Multiple")) {
        cues.push({ sayOnce: "kiosk.one_person", gap: PROMPT_VOICE_GAP_MS });
        phase = { kind: "prompt", text: "One person at a time, please", tone: "warn" };
      } else if (reason?.startsWith("Move")) {
        cues.push({ sayOnce: reason.includes("closer") ? "kiosk.move_closer" : "kiosk.move_circle", gap: PROMPT_VOICE_GAP_MS });
        phase = { kind: "prompt", text: reason, tone: "warn" };
      }
      return conclusive({ cues, phase, waitMs: 450 });
    }
  }
}

/** What went wrong when the request itself failed: no answer from the server, or a refusal. */
export function interpretRequestFailure(err: any, connectionText: string, errorText: (err: unknown) => string): Outcome {
  const refused = !!err?.response;
  return held(
    refused ? notice("Not recorded", errorText(err), "error") : notice("Connection problem", connectionText, "error"),
    NOTICE_HOLD_MS,
    [{ chime: false }, { say: refused ? "kiosk.not_recorded" : "kiosk.no_connection", delay: VOICE_AFTER_CHIME_MS }],
  );
}
