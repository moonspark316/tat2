import type { ColorName } from "./types";

export interface Swatch {
  name: ColorName;
  /** Saturated color used for the selector dot. */
  dot: string;
  /** Soft page tint behind the editor. */
  bg: string;
  /** Slightly stronger tint for the chrome (top/bottom bars). */
  chrome: string;
  /** Foreground text color. */
  ink: string;
}

export const PALETTE: Swatch[] = [
  { name: "amber", dot: "#E3B341", bg: "#FBF6E9", chrome: "#F6EDD4", ink: "#3a3326" },
  { name: "orange", dot: "#E08B3C", bg: "#FBF0E6", chrome: "#F6E4D2", ink: "#3a2e22" },
  { name: "red", dot: "#D95757", bg: "#FBEAEA", chrome: "#F6D9D9", ink: "#3a2626" },
  { name: "purple", dot: "#8B5CF6", bg: "#F3EEFB", chrome: "#E8DEF8", ink: "#2f2840" },
  { name: "blue", dot: "#4A90D9", bg: "#EAF1FB", chrome: "#D8E6F6", ink: "#243140" },
  { name: "teal", dot: "#38B2AC", bg: "#E7F6F5", chrome: "#D2EEEC", ink: "#22383a" },
  { name: "green", dot: "#5FA85F", bg: "#EEF6EA", chrome: "#DDEED4", ink: "#283a26" },
];

export const PALETTE_ORDER: ColorName[] = PALETTE.map((s) => s.name);

export function swatch(name: ColorName): Swatch {
  return PALETTE.find((s) => s.name === name) ?? PALETTE[0];
}

/** Pick the next palette color not already used (falls back to cycling). */
export function nextColor(used: ColorName[]): ColorName {
  const free = PALETTE_ORDER.find((c) => !used.includes(c));
  if (free) return free;
  return PALETTE_ORDER[used.length % PALETTE_ORDER.length];
}
