import { describe, expect, it } from "vitest";
import { nextColor, swatch, themeVars, PALETTE_ORDER } from "./palette";

describe("nextColor", () => {
  it("returns the first unused palette color", () => {
    expect(nextColor([])).toBe("amber");
    expect(nextColor(["amber"])).toBe("orange");
    expect(nextColor(["amber", "orange", "red"])).toBe("purple");
  });

  it("cycles deterministically once all colors are used", () => {
    expect(nextColor([...PALETTE_ORDER])).toBe(PALETTE_ORDER[0]);
  });
});

describe("swatch", () => {
  it("returns the requested swatch", () => {
    expect(swatch("blue").name).toBe("blue");
  });

  it("falls back to the first swatch for an unknown color", () => {
    // @ts-expect-error testing the runtime fallback
    expect(swatch("chartreuse").name).toBe("amber");
  });
});

describe("themeVars", () => {
  it("returns light vars by default and dark vars when requested", () => {
    const s = swatch("red");
    expect(themeVars(s, false).bg).toBe(s.bg);
    expect(themeVars(s, true).bg).toBe(s.darkBg);
    // The dot color is shared across themes.
    expect(themeVars(s, true).dot).toBe(s.dot);
  });
});
