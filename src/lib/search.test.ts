import { describe, expect, it } from "vitest";
import { findMatches, searchAllPads } from "./search";
import type { PadMeta } from "../types";

describe("findMatches", () => {
  it("returns nothing for an empty query", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });

  it("is case-insensitive and finds all non-overlapping matches", () => {
    const m = findMatches("Foo foo FOO", "foo");
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ start: 0, end: 3 });
    expect(m[1]).toEqual({ start: 4, end: 7 });
  });

  it("does not produce overlapping matches", () => {
    // 'aa' in 'aaa' matches once (0-2), then resumes at 2
    expect(findMatches("aaa", "aa")).toEqual([{ start: 0, end: 2 }]);
  });

  it("ranges map back to the original substring", () => {
    const text = "the quick brown fox";
    const [m] = findMatches(text, "quick");
    expect(text.slice(m.start, m.end)).toBe("quick");
  });
});

const pad = (id: string, color: PadMeta["color"]): PadMeta => ({
  id,
  title: "Sketchpad",
  color,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

describe("searchAllPads", () => {
  it("ignores whitespace-only queries", () => {
    expect(searchAllPads([pad("a", "red")], { a: "x" }, "   ")).toEqual([]);
  });

  it("returns a hit whose offset is the absolute char index", () => {
    const content = "first line\nsecond needle here\nthird";
    const hits = searchAllPads([pad("a", "blue")], { a: content }, "needle");
    expect(hits).toHaveLength(1);
    expect(hits[0].lineNo).toBe(2);
    // The offset must point exactly at the match in the whole document.
    expect(content.slice(hits[0].offset, hits[0].offset + 6)).toBe("needle");
  });

  it("computes offsets correctly across multiple lines", () => {
    const content = "aa\nbb\ncc match";
    const [hit] = searchAllPads([pad("a", "green")], { a: content }, "match");
    expect(content.slice(hit.offset, hit.offset + 5)).toBe("match");
    expect(hit.lineNo).toBe(3);
  });

  it("searches across multiple pads and labels them", () => {
    const hits = searchAllPads(
      [pad("a", "red"), pad("b", "blue")],
      { a: "alpha target", b: "beta target" },
      "target",
    );
    expect(hits.map((h) => h.padId).sort()).toEqual(["a", "b"]);
  });

  it("caps results per pad", () => {
    const content = Array.from({ length: 50 }, () => "x").join("\n");
    const hits = searchAllPads([pad("a", "amber")], { a: content }, "x", 10);
    expect(hits).toHaveLength(10);
  });
});
