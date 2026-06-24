import { describe, expect, it } from "vitest";
import { computeStats, firstLine, padLabel, formatRevision } from "./text";

describe("computeStats", () => {
  it("counts an empty document as all zeros", () => {
    expect(computeStats("")).toEqual({ chars: 0, words: 0, lines: 0 });
  });

  it("counts chars, words, lines", () => {
    expect(computeStats("hello world")).toEqual({
      chars: 11,
      words: 2,
      lines: 1,
    });
  });

  it("treats a trailing newline as an extra line", () => {
    expect(computeStats("a\n").lines).toBe(2);
    expect(computeStats("a\nb\nc").lines).toBe(3);
  });

  it("ignores extra whitespace when counting words", () => {
    expect(computeStats("  hello   world  ").words).toBe(2);
    expect(computeStats("   ").words).toBe(0);
  });

  it("counts unicode by code unit length (matches the UI)", () => {
    expect(computeStats("café").chars).toBe(4);
  });
});

describe("firstLine", () => {
  it("returns a placeholder for blank content", () => {
    expect(firstLine("")).toBe("Empty pad");
    expect(firstLine("\n\n   \n")).toBe("Empty pad");
  });

  it("returns the first non-empty line, trimmed and capped", () => {
    expect(firstLine("\n\n  hello there  \nmore")).toBe("hello there");
    expect(firstLine("x".repeat(100)).length).toBe(40);
  });
});

describe("padLabel", () => {
  it("prefers an explicit title", () => {
    expect(padLabel("My notes", "anything")).toBe("My notes");
  });

  it("falls back to the first line for default/empty titles", () => {
    expect(padLabel("Sketchpad", "first line\nsecond")).toBe("first line");
    expect(padLabel("", "first line")).toBe("first line");
  });
});

describe("formatRevision", () => {
  const now = 1_000_000_000_000;
  it("uses relative wording for recent times", () => {
    expect(formatRevision(now - 5_000, now)).toBe("just now");
    expect(formatRevision(now - 120_000, now)).toBe("2 min ago");
    expect(formatRevision(now - 2 * 3_600_000, now)).toBe("2 hr ago");
  });

  it("falls back to an absolute date past a day", () => {
    const out = formatRevision(now - 48 * 3_600_000, now);
    expect(out).not.toMatch(/ago|just now/);
  });
});
