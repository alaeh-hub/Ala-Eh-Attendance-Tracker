import { describe, expect, it } from "vitest";
import { type ScheduleDraft, breakFit, breakProblem, isOvernight, middleBreak } from "./scheduleRules";

const fixed = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  has_shifting: false,
  start_time: "08:00",
  end_time: "17:00",
  break_start: "12:00",
  break_end: "13:00",
  shifts: [],
  ...over,
});

describe("isOvernight", () => {
  it("treats an end at or before the start as the next day", () => {
    expect(isOvernight("22:00", "06:00")).toBe(true);
    expect(isOvernight("08:00", "08:00")).toBe(true);
    expect(isOvernight("08:00", "17:00")).toBe(false);
  });
  it("is false when either side is missing", () => {
    expect(isOvernight(null, "06:00")).toBe(false);
    expect(isOvernight("22:00", undefined)).toBe(false);
  });
});

describe("breakFit", () => {
  it("finds a lunch break inside a day shift", () => {
    expect(breakFit("08:00", "17:00", "12:00", "13:00")).toBe("inside");
  });
  it("finds a break that crosses midnight inside a night shift", () => {
    expect(breakFit("22:00", "06:00", "23:30", "00:30")).toBe("inside");
    expect(breakFit("22:00", "06:00", "01:00", "02:00")).toBe("inside");
  });
  it("finds a daytime break outside a night shift", () => {
    expect(breakFit("22:00", "06:00", "12:00", "13:00")).toBe("outside");
  });
  it("finds a break that runs over the end of the shift", () => {
    expect(breakFit("08:00", "17:00", "16:30", "17:30")).toBe("straddles");
  });
});

describe("middleBreak", () => {
  it("puts a one-hour break at the half-hour just before the middle of the hours", () => {
    expect(middleBreak("08:00", "17:00")).toEqual(["12:00", "13:00"]);
    expect(middleBreak("09:00", "18:00")).toEqual(["13:00", "14:00"]);
  });
  it("wraps past midnight for a night shift, and the result fits the shift", () => {
    const [start, end] = middleBreak("22:00", "06:00");
    expect(breakFit("22:00", "06:00", start, end)).toBe("inside");
  });
});

describe("breakProblem", () => {
  it("accepts a break inside fixed hours", () => {
    expect(breakProblem(fixed())).toBeNull();
  });
  it("asks for both break times", () => {
    expect(breakProblem(fixed({ break_end: "" }))).toBe("Enter a break start and end time.");
  });
  it("rejects a break that ends when it starts", () => {
    expect(breakProblem(fixed({ break_end: "12:00" }))).toBe("Break end must be after break start.");
  });
  it("rejects a daytime break on a night schedule, naming the hours", () => {
    expect(breakProblem(fixed({ start_time: "22:00", end_time: "06:00" }))).toBe("The 12:00–13:00 break must fall inside the 22:00–06:00 working hours.");
  });
  it("lets a rotating shift lie outside the break but not overlap its edge", () => {
    const shifts = [
      { name: "Morning", start_time: "06:00", end_time: "14:00" },
      { name: "Night", start_time: "22:00", end_time: "06:00" },
    ];
    expect(breakProblem(fixed({ has_shifting: true, shifts }))).toBeNull();
    const msg = breakProblem(fixed({ has_shifting: true, shifts, break_start: "13:30", break_end: "14:30" }));
    expect(msg).toContain('overlaps the start or end of the "Morning" shift');
  });
});
