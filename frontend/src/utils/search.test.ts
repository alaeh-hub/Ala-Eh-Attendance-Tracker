import { describe, expect, it } from "vitest";
import { smartMatch } from "./search";

describe("smartMatch", () => {
  const juan = ["Juan Dela Cruz", "juan@example.test", "EMP-0007", "HR", null];

  it("matches everything on an empty query", () => {
    expect(smartMatch("", juan)).toBe(true);
    expect(smartMatch("   ", juan)).toBe(true);
  });

  it("finds words across different fields in any order", () => {
    expect(smartMatch("juan hr", juan)).toBe(true);
    expect(smartMatch("hr juan", juan)).toBe(true);
    expect(smartMatch("emp-0007 cruz", juan)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(smartMatch("JUAN", juan)).toBe(true);
  });

  it("requires every word to match", () => {
    expect(smartMatch("juan finance", juan)).toBe(false);
  });

  it("does not match a word split across two fields", () => {
    expect(smartMatch("cruzemp", juan)).toBe(false);
  });

  it("ignores null and undefined fields", () => {
    expect(smartMatch("juan", [null, undefined, "Juan"])).toBe(true);
  });
});
