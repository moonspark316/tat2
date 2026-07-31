import { describe, expect, it } from "vitest";
import {
  computeDotFit,
  selectVisibleDots,
  DEFAULT_GEOMETRY,
  type DotFitGeometry,
} from "./dotFit";

// Fixed geometry matching App.css so the arithmetic below is readable:
//   dot=16, gap=12, add=16, chip=16.
const geo: DotFitGeometry = DEFAULT_GEOMETRY;

// Helpers for expected widths given the geometry.
const dots = (n: number) => (n <= 0 ? 0 : n * geo.dot + (n - 1) * geo.gap);
const addBudget = geo.gap + geo.add; // gap before the trailing add button

describe("computeDotFit", () => {
  it("returns nothing for zero pads", () => {
    expect(computeDotFit(0, 500)).toEqual({
      visibleCount: 0,
      showChip: false,
      overflowCount: 0,
    });
  });

  it("shows all dots (no chip) when everything fits", () => {
    // 5 dots + add fit comfortably.
    const need = dots(5) + addBudget;
    const r = computeDotFit(5, need + 10, geo);
    expect(r).toEqual({ visibleCount: 5, showChip: false, overflowCount: 0 });
  });

  it("shows all dots when they exactly fit (boundary, no chip)", () => {
    const exact = dots(5) + addBudget;
    const r = computeDotFit(5, exact, geo);
    expect(r.showChip).toBe(false);
    expect(r.visibleCount).toBe(5);
  });

  it("spills into a chip when many pads overflow", () => {
    // Give room for ~3 dots + chip + add. With 20 pads that's a big overflow.
    const reserved = geo.chip + geo.gap + geo.add + geo.gap;
    const room = dots(3);
    const available = room + reserved;
    const r = computeDotFit(20, available, geo);
    expect(r.showChip).toBe(true);
    expect(r.visibleCount).toBe(3);
    expect(r.overflowCount).toBe(17);
    expect(r.visibleCount + r.overflowCount).toBe(20);
  });

  it("NEVER shows a '+1' chip (anti-flicker): keeps the lone dot instead", () => {
    // Use a geometry where the chip is CHEAPER than a dot, so the fit math can
    // land on exactly one hidden pad — the case the anti-flicker guard exists
    // for. (With default geometry the chip and a dot cost the same, so this
    // exact-1 transition is unreachable; a tiny chip makes it reachable.)
    const g: DotFitGeometry = { dot: 16, gap: 12, add: 16, chip: 4 };
    // Room for 5 dots + chip(4) + add, but not a 6th dot.
    const reserved = g.chip + g.gap + g.add + g.gap; // 4+12+16+12 = 44
    const available = 5 * g.dot + 4 * g.gap + reserved; // exactly 5 dots + chrome
    const r = computeDotFit(6, available, g);
    // Rather than "+1", we keep all 6 as dots, no chip.
    expect(r.showChip).toBe(false);
    expect(r.overflowCount).toBe(0);
    expect(r.visibleCount).toBe(6);
  });

  it("degrades to zero fitting dots at extremely narrow widths", () => {
    const r = computeDotFit(10, 20, geo);
    expect(r.visibleCount).toBe(0);
    expect(r.showChip).toBe(true);
    expect(r.overflowCount).toBe(10);
  });
});

describe("selectVisibleDots", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];

  it("takes the first N when the active pad is already in the window", () => {
    expect(selectVisibleDots(ids, 3, "b")).toEqual(["a", "b", "c"]);
  });

  it("takes the first N when there is no active pad", () => {
    expect(selectVisibleDots(ids, 3, null)).toEqual(["a", "b", "c"]);
  });

  it("pins the active pad as the last dot when it sorts past the window", () => {
    // active "f" is beyond the first 3; it replaces "c" as the last dot.
    expect(selectVisibleDots(ids, 3, "f")).toEqual(["a", "b", "f"]);
  });

  it("keeps count stable when pinning (drops the would-be-last id)", () => {
    const out = selectVisibleDots(ids, 4, "e");
    expect(out).toHaveLength(4);
    expect(out).toEqual(["a", "b", "c", "e"]);
  });

  it("ignores an active id that isn't in the visible list", () => {
    expect(selectVisibleDots(ids, 2, "zzz")).toEqual(["a", "b"]);
  });

  it("handles a single-dot window pinning the active pad", () => {
    expect(selectVisibleDots(ids, 1, "d")).toEqual(["d"]);
  });

  it("clamps count to the list length", () => {
    expect(selectVisibleDots(ids, 99, "a")).toEqual(ids);
  });
});
