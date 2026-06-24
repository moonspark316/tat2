import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("marks identical text as context", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.type === "ctx")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("detects an added line", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d).toContainEqual({ type: "add", text: "b" });
    // a and c remain context
    expect(d.filter((l) => l.type === "ctx").map((l) => l.text)).toEqual([
      "a",
      "c",
    ]);
  });

  it("detects a removed line", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(d).toContainEqual({ type: "del", text: "b" });
  });

  it("handles a full replacement", () => {
    const d = diffLines("old", "new");
    expect(d).toContainEqual({ type: "del", text: "old" });
    expect(d).toContainEqual({ type: "add", text: "new" });
  });

  it("handles empty inputs without throwing", () => {
    expect(diffLines("", "")).toEqual([{ type: "ctx", text: "" }]);
    expect(diffLines("", "x")).toContainEqual({ type: "add", text: "x" });
  });

  it("reconstructs the new text from ctx+add lines", () => {
    const oldT = "one\ntwo\nthree";
    const newT = "one\nTWO\nthree\nfour";
    const rebuilt = diffLines(oldT, newT)
      .filter((l) => l.type !== "del")
      .map((l) => l.text)
      .join("\n");
    expect(rebuilt).toBe(newT);
  });
});
