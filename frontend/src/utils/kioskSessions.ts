// Which part of the day the kiosk lets an employee pick. These mirror how the server
// decides a punch (backend attendance_service.resolve_punch), so the buttons only offer
// choices the server would actually record:
//   time in  -> morning before the lunch break starts, afternoon from then on
//   time out -> morning up to the end of the lunch break, afternoon after it
// Overtime is never time-restricted here: it is always an explicit choice.

export type Direction = "IN" | "OUT";
export type Session = "AM" | "PM" | "OT";

/** Lunch break as minutes since midnight, in the organisation's timezone. */
export interface BreakWindow {
  start: number;
  end: number;
}

export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Used until the server's break window arrives: split the day at noon. */
export const NOON: BreakWindow = { start: 720, end: 720 };

export function sessionAllowed(session: Session, direction: Direction, nowMin: number, win: BreakWindow = NOON): boolean {
  if (session === "OT") return true;
  if (direction === "IN") return session === "AM" ? nowMin < win.start : nowMin >= win.start;
  return session === "AM" ? nowMin <= win.end : nowMin > win.end;
}

/** The morning/afternoon choice that makes sense right now. */
export function defaultSession(direction: Direction, nowMin: number, win: BreakWindow = NOON): Session {
  return sessionAllowed("AM", direction, nowMin, win) ? "AM" : "PM";
}

export function formatMinutes(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Why a choice is unavailable, for a tooltip / screen reader. */
export function sessionHint(session: Session, direction: Direction, win: BreakWindow = NOON): string {
  if (session === "PM") return direction === "IN" ? `Afternoon opens at ${formatMinutes(win.start)}` : `Afternoon time out opens after ${formatMinutes(win.end)}`;
  if (session === "AM") return direction === "IN" ? "Morning time in has closed" : "Morning time out has closed";
  return "";
}
