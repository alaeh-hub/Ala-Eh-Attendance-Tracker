import { afterEach, describe, expect, it } from "vitest";
import {
  datetimeLocalToApi,
  formatDate,
  formatDateTime,
  formatTime,
  isValidTimeZone,
  orgDate,
  orgMinutesNow,
  orgMonthStart,
  orgNow,
  orgParts,
  toDatetimeLocal,
  useOrgStore,
} from "./orgTime";

const meta = (timezone: string, now: string) => ({
  timezone,
  now,
  today: now.slice(0, 10),
  break_start: "12:00",
  break_end: "13:00",
  shift_start: "08:00",
  shift_end: "17:00",
});

describe("orgTime", () => {
  const initial = useOrgStore.getState();
  afterEach(() => useOrgStore.setState({ timeZone: initial.timeZone, meta: null, clockSkewMs: 0 }));

  it("formats instants in the organisation's timezone, not the browser's", () => {
    const iso = "2026-03-01T23:30:00Z"; // 07:30 next day in Manila
    expect(formatTime(iso, "Asia/Manila")).toMatch(/7:30/);
    expect(formatTime(iso, "UTC")).toMatch(/11:30/);
    expect(formatDateTime(iso, "Asia/Manila")).toMatch(/Mar 2/);
    expect(formatDateTime(iso, "UTC")).toMatch(/Mar 1/);
    expect(formatTime(null)).toBe("—");
  });

  it("uses the timezone from /api/meta once it is loaded", () => {
    useOrgStore.getState().setMeta(meta("Asia/Manila", new Date().toISOString()));
    expect(useOrgStore.getState().timeZone).toBe("Asia/Manila");
    expect(formatTime("2026-03-01T23:30:00Z")).toMatch(/7:30/);
  });

  it("ignores an unknown timezone", () => {
    useOrgStore.getState().setMeta(meta("Not/AZone", new Date().toISOString()));
    expect(useOrgStore.getState().timeZone).toBe(initial.timeZone);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  it("corrects a wrong tablet clock with the server's", () => {
    const fetchedAt = Date.now();
    useOrgStore.getState().setMeta(meta("UTC", new Date(fetchedAt + 10 * 60_000).toISOString()), fetchedAt);
    expect(orgNow().getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it("works out 'today' across midnight per timezone", () => {
    const lateUtc = new Date("2026-03-01T20:00:00Z"); // 04:00 on Mar 2 in Manila
    expect(orgDate(0, lateUtc, "UTC")).toBe("2026-03-01");
    expect(orgDate(0, lateUtc, "Asia/Manila")).toBe("2026-03-02");
    expect(orgDate(-1, lateUtc, "Asia/Manila")).toBe("2026-03-01");
    expect(orgDate(1, new Date("2026-12-31T20:00:00Z"), "Asia/Manila")).toBe("2027-01-02");
    expect(orgMonthStart(new Date("2026-03-31T20:00:00Z"), "Asia/Manila")).toBe("2026-04-01");
    expect(orgMinutesNow(lateUtc, "Asia/Manila")).toBe(4 * 60);
    expect(orgParts(lateUtc, "Asia/Manila")).toMatchObject({ year: 2026, month: 3, day: 2, hour: 4 });
  });

  it("formats a bare calendar date as that date in every timezone", () => {
    expect(formatDate("2026-03-02", { month: "short", day: "numeric" }, "Pacific/Honolulu")).toBe("Mar 2");
    expect(formatDate("2026-03-02", { month: "short", day: "numeric" }, "Pacific/Kiritimati")).toBe("Mar 2");
  });

  it("sends datetime-local values as naive org-local wall time", () => {
    expect(datetimeLocalToApi("2026-03-02T08:15")).toBe("2026-03-02T08:15:00");
    expect(datetimeLocalToApi("2026-03-02T08:15:30")).toBe("2026-03-02T08:15:30");
    expect(toDatetimeLocal("2026-03-01T23:30:00Z", "Asia/Manila")).toBe("2026-03-02T07:30");
    expect(toDatetimeLocal("2026-03-01T23:30:00Z", "UTC")).toBe("2026-03-01T23:30");
  });
});
