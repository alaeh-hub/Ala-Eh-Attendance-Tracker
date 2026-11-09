import type { AttendanceEvent, DailyRow } from "../../types";
import { orgDate, orgMonthStart } from "../../utils/orgTime";

export type EventRow = AttendanceEvent;
/** Daily-report fields added by the backend (row `date` is the shift's work day). */
export type DayRow = DailyRow;

export type PresetKey = "today" | "yesterday" | "week" | "month";

export const ROWS_PER_PAGE = 200;
export const PAGE_SIZE = 100;
export const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

/**
 * A shift whose last punch is a clock-in is only "on site" while that work day can still be running. Anything older was never
 * closed. Yesterday's shift may still be running when it is a night shift that started yesterday.
 */
export function missedTimeOut(r: DayRow): boolean {
  if (typeof r.no_time_out === "boolean") return r.no_time_out;
  if (!r.open || r.last_out) return false;
  const yesterday = orgDate(-1);
  if (r.date < yesterday) return true;
  if (r.date > yesterday) return false;
  const overnight = !!r.scheduled_start && !!r.scheduled_end && r.scheduled_end <= r.scheduled_start;
  return !overnight;
}

/** Date presets in the organisation's timezone, not the browser's. */
export function preset(kind: PresetKey): [string, string] {
  const today = orgDate(0);
  if (kind === "today") return [today, today];
  if (kind === "yesterday") {
    const y = orgDate(-1);
    return [y, y];
  }
  if (kind === "week") {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return [orgDate(-((weekday + 6) % 7)), today]; // Monday
  }
  return [orgMonthStart(), today];
}

export const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

export function eventLabel(e: Pick<AttendanceEvent, "event_type">) {
  return e.event_type === "CLOCK_IN" ? "clock-in" : "clock-out";
}
