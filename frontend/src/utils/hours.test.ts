import { describe, expect, it } from "vitest";
import { hoursLabel } from "./hours";

describe("hoursLabel", () => {
  it("shows hours and zero-padded minutes", () => {
    expect(hoursLabel(0)).toBe("0h 00m");
    expect(hoursLabel(7.5)).toBe("7h 30m");
    expect(hoursLabel(7.0833)).toBe("7h 05m");
  });
  it("rolls 60 minutes over into the next hour", () => {
    expect(hoursLabel(7.999)).toBe("8h 00m");
  });
});
