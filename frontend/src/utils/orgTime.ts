import { create } from "zustand";

/**
 * Organisation timezone. The server decides "today", shifts and lateness in
 * the organisation's timezone; the browser's own clock/timezone may be wrong
 * (a kiosk tablet set to UTC, an admin travelling). Every displayed time and
 * every date preset goes through these helpers so the UI agrees with the server.
 *
 * The timezone is loaded from GET /api/meta after sign-in (see loadOrgMeta).
 * Until then the browser timezone is used.
 */
export interface OrgMeta {
  timezone: string;
  break_start: string;
  break_end: string;
  shift_start: string;
  shift_end: string;
  /** Server clock (org-local ISO) at fetch time, and the browser clock at that moment. */
  now: string;
  today: string;
}

interface OrgState {
  timeZone: string;
  meta: OrgMeta | null;
  /** serverNowMs - browserNowMs at the last /meta fetch, to correct a wrong tablet clock. */
  clockSkewMs: number;
  setMeta: (meta: OrgMeta, fetchedAtMs?: number) => void;
}

const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export const useOrgStore = create<OrgState>((set) => ({
  timeZone: browserTz,
  meta: null,
  clockSkewMs: 0,
  setMeta: (meta, fetchedAtMs = Date.now()) => {
    const serverMs = Date.parse(meta.now);
    set({
      meta,
      timeZone: isValidTimeZone(meta.timezone) ? meta.timezone : browserTz,
      clockSkewMs: Number.isFinite(serverMs) ? serverMs - fetchedAtMs : 0,
    });
  },
}));

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function orgTimeZone(): string {
  return useOrgStore.getState().timeZone;
}

/** Current time corrected by the server clock skew measured at the last /meta fetch. */
export function orgNow(): Date {
  return new Date(Date.now() + useOrgStore.getState().clockSkewMs);
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatTime(iso: string | null | undefined, tz: string = orgTimeZone()): string {
  if (!iso) return "—";
  return toDate(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function formatTimeWithSeconds(value: string | number | Date, tz: string = orgTimeZone()): string {
  return toDate(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz });
}

export function formatDateTime(iso: string | null | undefined, tz: string = orgTimeZone()): string {
  if (!iso) return "—";
  return toDate(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function formatDate(
  value: string | number | Date,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" },
  tz: string = orgTimeZone(),
): string {
  // A bare "YYYY-MM-DD" is a calendar date, not an instant: format it as-is.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString([], { ...opts, timeZone: "UTC" });
  }
  return toDate(value).toLocaleDateString([], { ...opts, timeZone: tz });
}

/** The parts of an instant as seen in the org timezone. */
export function orgParts(value: string | number | Date = orgNow(), tz: string = orgTimeZone()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(toDate(value));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** "YYYY-MM-DD" for today in the org timezone, shifted by `offsetDays`. */
export function orgDate(offsetDays = 0, from: Date = orgNow(), tz: string = orgTimeZone()): string {
  const { year, month, day } = orgParts(from, tz);
  const d = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return d.toISOString().slice(0, 10);
}

/** First day of the org-local month containing `from` ("YYYY-MM-DD"). */
export function orgMonthStart(from: Date = orgNow(), tz: string = orgTimeZone()): string {
  const { year, month } = orgParts(from, tz);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Minutes since org-local midnight. */
export function orgMinutesNow(from: Date = orgNow(), tz: string = orgTimeZone()): number {
  const { hour, minute, second } = orgParts(from, tz);
  return hour * 60 + minute + second / 60;
}

/**
 * A `<input type="datetime-local">` value ("YYYY-MM-DDTHH:mm") is wall-clock
 * time with no zone. Send it to the API as-is (no "Z", no offset): the server
 * interprets naive timestamps in the org timezone. Never pass it through
 * `new Date(...)`, which would apply the browser's timezone instead.
 */
export function datetimeLocalToApi(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

/** An instant as a `datetime-local` value in the org timezone. */
export function toDatetimeLocal(value: string | number | Date = orgNow(), tz: string = orgTimeZone()): string {
  const p = orgParts(value, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
