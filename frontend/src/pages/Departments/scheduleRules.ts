import type { Shift } from "../../types";
import { toMinutes } from "../../utils/kioskSessions";

const DAY = 24 * 60;

/** The schedule fields of the department form that the break rules look at. */
export interface ScheduleDraft {
  has_shifting: boolean;
  start_time: string;
  end_time: string;
  break_start: string;
  break_end: string;
  shifts: Shift[];
}

/** End at or before start means the shift ends the next day (e.g. 22:00–06:00). */
export function isOvernight(start: string | null | undefined, end: string | null | undefined) {
  return !!start && !!end && toMinutes(end) <= toMinutes(start);
}

/**
 * Where a break lies relative to a shift — the same rule the server applies.
 * Both are measured as offsets from the shift start, so overnight shifts and
 * breaks crossing midnight (23:30–00:30 in a 22:00–06:00 shift) compare correctly.
 */
export function breakFit(shiftStart: string, shiftEnd: string, breakStart: string, breakEnd: string): "inside" | "outside" | "straddles" {
  const s = toMinutes(shiftStart);
  const span = (((toMinutes(shiftEnd) - s) % DAY) + DAY) % DAY || DAY;
  const b0 = (((toMinutes(breakStart) - s) % DAY) + DAY) % DAY;
  const b1 = b0 + ((((toMinutes(breakEnd) - toMinutes(breakStart)) % DAY) + DAY) % DAY);
  if (b1 <= span) return "inside";
  if (b0 >= span && b1 <= DAY) return "outside";
  return "straddles";
}

/** A one-hour break in the middle of a shift ("HH:MM" pair). */
export function middleBreak(start: string, end: string): [string, string] {
  const s = toMinutes(start);
  const span = (((toMinutes(end) - s) % DAY) + DAY) % DAY || DAY;
  const b0 = (s + Math.floor(span / 2 / 30) * 30 - 30 + DAY) % DAY;
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [fmt(b0), fmt((b0 + 60) % DAY)];
}

/** Why the break doesn't fit the schedule (mirrors the server's check), or null. */
export function breakProblem(form: ScheduleDraft): string | null {
  const { break_start: bs, break_end: be } = form;
  if (!bs || !be) return "Enter a break start and end time.";
  if (bs === be) return "Break end must be after break start.";
  if (!form.has_shifting && form.start_time && form.end_time && form.start_time !== form.end_time) {
    if (breakFit(form.start_time, form.end_time, bs, be) !== "inside")
      return `The ${bs}–${be} break must fall inside the ${form.start_time}–${form.end_time} working hours.`;
  }
  if (form.has_shifting) {
    const bad = form.shifts.find((sh) => sh.start_time !== sh.end_time && breakFit(sh.start_time, sh.end_time, bs, be) === "straddles");
    if (bad) return `The ${bs}–${be} break overlaps the start or end of the "${bad.name}" shift (${bad.start_time}–${bad.end_time}).`;
  }
  return null;
}
