import { describe, expect, it } from "vitest";
import { matchRanges, smartFilter, smartMatch, smartRank } from "./search";

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

describe("smartMatch: forgiving matching", () => {
  const jose = ["José Núñez", "jose@example.test", "EMP-0007", "Human Resources", "Line Lead"];

  it("ignores accents in both directions", () => {
    expect(smartMatch("jose nunez", jose)).toBe(true);
    expect(smartMatch("José", ["Jose Santos"])).toBe(true);
  });

  it("ignores punctuation and spacing inside codes", () => {
    expect(smartMatch("emp 0007", jose)).toBe(true);
    expect(smartMatch("emp0007", jose)).toBe(true);
  });

  it("matches the start of a word and a word inside a longer one", () => {
    expect(smartMatch("hum res", jose)).toBe(true);
    expect(smartMatch("ources", jose)).toBe(true);
  });

  it("forgives one typo in a 4 to 7 letter word, including a swapped pair", () => {
    expect(smartMatch("jaun", ["Juan Dela Cruz"])).toBe(true);
    expect(smartMatch("juam", ["Juan Dela Cruz"])).toBe(true);
    expect(smartMatch("crux", ["Juan Dela Cruz"])).toBe(true);
  });

  it("forgives two typos in an 8+ letter word", () => {
    expect(smartMatch("resorces", ["Human Resources"])).toBe(true);
    expect(smartMatch("humen resurces", ["Human Resources"])).toBe(true);
  });

  it("forgives a typo in a word that is still being typed", () => {
    expect(smartMatch("jaunit", ["Juanito Reyes"])).toBe(true);
  });

  it("does not guess on short words or unrelated ones", () => {
    expect(smartMatch("jin", ["Juan"])).toBe(false);
    expect(smartMatch("zebra", ["Juan Dela Cruz", "HR"])).toBe(false);
  });

  it("never fuzzes anything containing a digit, so employee codes stay exact", () => {
    expect(smartMatch("emp-0008", ["EMP-0007"])).toBe(false);
    expect(smartMatch("0007", ["EMP-0007"])).toBe(true);
  });

  it("finds a name written without its space", () => {
    expect(smartMatch("delacruz", ["Juan Dela Cruz"])).toBe(true);
  });
});

describe("smartFilter and smartRank", () => {
  const people = [
    { n: "Maria Santos", d: "HR" },
    { n: "Mario Santiago", d: "Finance" },
    { n: "Anna Marin", d: "Mario Kitchen" },
  ];
  const fields = (p: { n: string; d: string }) => [p.n, p.d];

  it("returns the same array for an empty query", () => {
    expect(smartFilter(people, "  ", fields)).toBe(people);
  });

  it("filters, keeping order unless ranking is asked for", () => {
    expect(smartFilter(people, "mario", fields).map((p) => p.n)).toEqual(["Mario Santiago", "Anna Marin"]);
  });

  it("ranks a whole word above a word start above a near miss", () => {
    const out = smartFilter(people, "mario", fields, { rank: true }).map((p) => p.n);
    expect(out[0]).toBe("Mario Santiago");
    expect(smartFilter(["Marion", "Mario", "Marlo"], "mario", (s) => [s], { rank: true })).toEqual(["Mario", "Marion"]);
  });

  it("puts a name match ahead of the same word in a later field", () => {
    expect(smartFilter(people, "mario", fields, { rank: true })[0].n).toBe("Mario Santiago");
  });

  it("treats typo matches as a fallback, shown only when nothing matches literally", () => {
    expect(smartFilter(["Juan Cruz", "Jaun Reyes"], "juan", (s) => [s]).length).toBe(1);
    expect(smartFilter(["Juan Cruz", "Pedro Reyes"], "jaun", (s) => [s])).toEqual(["Juan Cruz"]);
  });

  it("smartRank reorders without dropping anything", () => {
    const out = smartRank(people, "anna", fields);
    expect(out).toHaveLength(3);
    expect(out[0].n).toBe("Anna Marin");
  });
});

describe("matchRanges", () => {
  it("marks literal matches in the original text, accents included", () => {
    expect(matchRanges("José Núñez", "nunez")).toEqual([[5, 10]]);
    expect(matchRanges("José Núñez", "jos")).toEqual([[0, 3]]);
  });

  it("marks every word of the query and merges neighbours", () => {
    expect(matchRanges("Juan Dela Cruz", "juan cruz")).toEqual([[0, 4], [10, 14]]);
    expect(matchRanges("abcd", "ab cd")).toEqual([[0, 4]]);
  });

  it("marks the word that was probably meant when the query has a typo", () => {
    expect(matchRanges("Juan Dela Cruz", "jaun")).toEqual([[0, 4]]);
  });

  it("returns nothing for an empty query or no match", () => {
    expect(matchRanges("Juan", "")).toEqual([]);
    expect(matchRanges("Juan", "zebra")).toEqual([]);
  });
});
