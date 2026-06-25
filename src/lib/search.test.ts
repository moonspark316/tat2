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

  it("keeps offsets in original-text space when lowercase changes length (#18)", () => {
    // "İ" (U+0130) lowercases to two UTF-16 units ("i" + combining dot).
    // A naive indexOf into text.toLowerCase() would mis-place every later hit.
    const text = "İ then foo";
    const [m] = findMatches(text, "foo");
    expect(text.slice(m.start, m.end)).toBe("foo");
  });

  it("matches a query against text whose case differs in length (#18)", () => {
    // The uppercase "İ" should match the lowercase query "i̇" at offset 0,
    // spanning exactly the single original code unit.
    const text = "İstanbul";
    const [m] = findMatches(text, "i̇");
    expect(m).toBeDefined();
    expect(m.start).toBe(0);
    expect(text.slice(m.start, m.end)).toBe("İ");
  });

  it("finds multiple non-overlapping matches around length-changing chars", () => {
    const text = "foo İ foo";
    const ms = findMatches(text, "foo");
    expect(ms).toHaveLength(2);
    for (const m of ms) expect(text.slice(m.start, m.end)).toBe("foo");
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

  it("offsets stay correct after a length-changing char earlier in the line (#18)", () => {
    // The "İ" lowercases to two units; the hit offset must point at the match
    // in the ORIGINAL content, not the lowercased one.
    const content = "İ prefix needle";
    const [hit] = searchAllPads([pad("a", "teal")], { a: content }, "needle");
    expect(hit).toBeDefined();
    expect(content.slice(hit.offset, hit.offset + hit.length)).toBe("needle");
  });

  it("reports the matched length, not the query length (#30)", () => {
    // Query "i̇" (2 units) matches the single-unit "İ" — length must be 1.
    const content = "İstanbul";
    const [hit] = searchAllPads([pad("a", "blue")], { a: content }, "i̇");
    expect(hit).toBeDefined();
    expect(hit.length).toBe(1);
    expect(content.slice(hit.offset, hit.offset + hit.length)).toBe("İ");
  });
});
