import { describe, expect, it } from "vitest";
import type { CheckInResult } from "../../types";
import {
  CORRECTED_HOLD_MS,
  NOTICE_HOLD_MS,
  NO_STREAK,
  SUCCESS_HOLD_MS,
  interpretCheckIn,
  interpretRequestFailure,
} from "./kioskOutcome";

const event = { id: "e1", user_id: "u1", user_name: "Maria Santos", event_type: "CLOCK_IN" } as NonNullable<CheckInResult["event"]>;
const result = (r: Partial<CheckInResult> & Pick<CheckInResult, "status">): CheckInResult => r;

describe("interpretCheckIn", () => {
  it("holds a recorded punch on screen, says what was recorded and clears the selection", () => {
    const { outcome } = interpretCheckIn(result({ status: "MATCHED", event }), NO_STREAK);
    expect(outcome.phase.kind).toBe("success");
    expect(outcome.holdMs).toBe(SUCCESS_HOLD_MS);
    expect(outcome.waitMs).toBe(SUCCESS_HOLD_MS);
    expect(outcome.recordedEvent).toBe(event);
    expect(outcome.cues).toEqual([{ chime: true }, { say: "kiosk.time_in", delay: 400 }]);
  });

  it("says time out for a time out, and keeps a corrected punch up longer", () => {
    const { outcome } = interpretCheckIn(
      result({ status: "MATCHED", event: { ...event, event_type: "CLOCK_OUT" }, corrected: true, correction_note: "You selected PM time in" }),
      NO_STREAK,
    );
    expect(outcome.holdMs).toBe(CORRECTED_HOLD_MS);
    expect(outcome.cues[1]).toEqual({ say: "kiosk.time_out", delay: 400 });
    expect(outcome.phase).toMatchObject({ kind: "success", note: "You selected PM time in" });
  });

  it("greets by first name when the punch is already on record", () => {
    const { outcome } = interpretCheckIn(result({ status: "COOLDOWN", user_name: "Maria Santos", reason: "Wait 30s", event }), NO_STREAK);
    expect(outcome.phase).toMatchObject({ kind: "notice", title: "Already recorded, Maria", text: "Wait 30s", tone: "warn", name: "Maria Santos" });
    expect(outcome.holdMs).toBe(NOTICE_HOLD_MS);
  });

  it("asks for a blink without ending the scan or touching the streaks", () => {
    const streak = { noMatch: 1, unsure: 2 };
    const { outcome, streak: next } = interpretCheckIn(result({ status: "LIVENESS_FAILED", first_name: "Maria" }), streak);
    expect(outcome.phase).toMatchObject({ kind: "prompt", text: "Hi Maria! Please blink 👀" });
    expect(outcome.holdMs).toBeUndefined();
    expect(outcome.waitMs).toBe(0);
    expect(next).toEqual(streak);
  });

  it("keeps trying on an unsure read, then gives up with an explanation on the fourth", () => {
    let streak = NO_STREAK;
    for (let i = 1; i <= 3; i++) {
      const step = interpretCheckIn(result({ status: "LOW_CONFIDENCE" }), streak);
      expect(step.outcome.holdMs).toBeUndefined();
      expect(step.outcome.waitMs).toBe(150);
      streak = step.streak;
      expect(streak.unsure).toBe(i);
    }
    const last = interpretCheckIn(result({ status: "AMBIGUOUS_MATCH" }), streak);
    expect(last.outcome.phase).toMatchObject({ kind: "notice", title: "Can't confirm who you are" });
    expect(last.outcome.holdMs).toBe(NOTICE_HOLD_MS);
    expect(last.streak.unsure).toBe(0);
  });

  it("says 'not recognized' only on the second no-match in a row", () => {
    const first = interpretCheckIn(result({ status: "NO_MATCH" }), NO_STREAK);
    expect(first.outcome.phase).toMatchObject({ kind: "prompt", text: "Checking… look at the camera" });
    expect(first.outcome.cues).toEqual([]);
    const second = interpretCheckIn(result({ status: "NO_MATCH" }), first.streak);
    expect(second.outcome.phase).toMatchObject({ kind: "notice", title: "Not recognized", tone: "error" });
    expect(second.streak.noMatch).toBe(0);
  });

  it("forgets earlier doubts as soon as something conclusive happens", () => {
    const { streak } = interpretCheckIn(result({ status: "NO_FACE", reason: "" }), { noMatch: 1, unsure: 3 });
    expect(streak).toEqual(NO_STREAK);
  });

  it("stays silent with nobody there, but speaks when someone must move or be alone", () => {
    const empty = interpretCheckIn(result({ status: "NO_FACE", reason: "No face detected" }), NO_STREAK).outcome;
    expect(empty.cues).toEqual([]);
    expect(empty.phase).toEqual({ kind: "idle" });
    expect(empty.waitMs).toBe(450);

    const crowd = interpretCheckIn(result({ status: "NO_FACE", reason: "Multiple faces" }), NO_STREAK).outcome;
    expect(crowd.cues).toEqual([{ sayOnce: "kiosk.one_person", gap: 6000 }]);
    expect(crowd.phase).toMatchObject({ kind: "prompt", text: "One person at a time, please" });

    const far = interpretCheckIn(result({ status: "NO_FACE", reason: "Move closer" }), NO_STREAK).outcome;
    expect(far.cues).toEqual([{ sayOnce: "kiosk.move_closer", gap: 6000 }]);
    const off = interpretCheckIn(result({ status: "NO_FACE", reason: "Move into the circle" }), NO_STREAK).outcome;
    expect(off.cues).toEqual([{ sayOnce: "kiosk.move_circle", gap: 6000 }]);
  });
});

describe("interpretRequestFailure", () => {
  const text = (e: unknown) => `refused: ${(e as Error).message}`;

  it("blames the connection when there was no answer at all", () => {
    const outcome = interpretRequestFailure(new Error("Network Error"), "check the connection", text);
    expect(outcome.phase).toMatchObject({ title: "Connection problem", text: "check the connection", tone: "error" });
    expect(outcome.cues).toEqual([{ chime: false }, { say: "kiosk.no_connection", delay: 400 }]);
  });

  it("reports the server's refusal when there was one", () => {
    const err = Object.assign(new Error("Too many scans"), { response: { status: 429 } });
    const outcome = interpretRequestFailure(err, "check the connection", text);
    expect(outcome.phase).toMatchObject({ title: "Not recorded", text: "refused: Too many scans" });
    expect(outcome.cues[1]).toEqual({ say: "kiosk.not_recorded", delay: 400 });
  });
});
