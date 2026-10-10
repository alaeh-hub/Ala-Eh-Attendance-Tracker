import { describe, expect, it } from "vitest";
import { NOON, defaultSession, formatMinutes, sessionAllowed, sessionHint, toMinutes } from "./kioskSessions";

const LUNCH = { start: toMinutes("12:00"), end: toMinutes("13:00") };
const at = (hhmm: string) => toMinutes(hhmm);

describe("kiosk morning / afternoon rules", () => {
  it("does not offer Afternoon before the afternoon starts", () => {
    expect(sessionAllowed("PM", "IN", at("09:30"), LUNCH)).toBe(false);
    expect(sessionAllowed("PM", "OUT", at("09:30"), LUNCH)).toBe(false);
    expect(sessionAllowed("AM", "IN", at("09:30"), LUNCH)).toBe(true);
  });

  it("opens Afternoon time in when lunch starts, but not Afternoon time out yet", () => {
    expect(sessionAllowed("PM", "IN", at("12:00"), LUNCH)).toBe(true);
    expect(sessionAllowed("AM", "IN", at("12:00"), LUNCH)).toBe(false);
    // Leaving at 12:05 is still the morning time out (the lunch break), as on the server.
    expect(sessionAllowed("AM", "OUT", at("12:05"), LUNCH)).toBe(true);
    expect(sessionAllowed("PM", "OUT", at("12:05"), LUNCH)).toBe(false);
  });

  it("after lunch only Afternoon is offered", () => {
    for (const dir of ["IN", "OUT"] as const) {
      expect(sessionAllowed("AM", dir, at("14:00"), LUNCH)).toBe(false);
      expect(sessionAllowed("PM", dir, at("14:00"), LUNCH)).toBe(true);
    }
  });

  it("never restricts overtime", () => {
    for (const t of ["06:00", "12:30", "20:00"]) expect(sessionAllowed("OT", "IN", at(t), LUNCH)).toBe(true);
  });

  it("falls back to noon until the server's break window is known", () => {
    expect(sessionAllowed("PM", "IN", at("11:59"), NOON)).toBe(false);
    expect(sessionAllowed("PM", "IN", at("12:00"), NOON)).toBe(true);
  });

  it("picks the sensible default for the time of day", () => {
    expect(defaultSession("IN", at("08:00"), LUNCH)).toBe("AM");
    expect(defaultSession("OUT", at("12:30"), LUNCH)).toBe("AM");
    expect(defaultSession("OUT", at("17:00"), LUNCH)).toBe("PM");
    expect(defaultSession("IN", at("13:30"), LUNCH)).toBe("PM");
  });

  it("explains why a choice is unavailable", () => {
    expect(sessionHint("PM", "IN", LUNCH)).toBe("Afternoon opens at 12:00 PM");
    expect(sessionHint("PM", "OUT", LUNCH)).toBe("Afternoon time out opens after 1:00 PM");
    expect(formatMinutes(0)).toBe("12:00 AM");
  });
});
