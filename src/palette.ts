import type { ColorName } from "./types";

export interface Swatch {
  name: ColorName;
  /** Saturated color used for the selector dot (same in both themes). */
  dot: string;
  /** Light theme. */
  bg: string;
  chrome: string;
  ink: string;
  /** Dark theme. */
  darkBg: string;
  darkChrome: string;
  darkInk: string;
}

export const PALETTE: Swatch[] = [
  { name: "amber",  dot: "#E3B341", bg: "#FBF6E9", chrome: "#F6EDD4", ink: "#3a3326", darkBg: "#2a2620", darkChrome: "#332e25", darkInk: "#ece4d2" },
  { name: "orange", dot: "#E08B3C", bg: "#FBF0E6", chrome: "#F6E4D2", ink: "#3a2e22", darkBg: "#2a231d", darkChrome: "#332a22", darkInk: "#efe2d5" },
  { name: "red",    dot: "#D95757", bg: "#FBEAEA", chrome: "#F6D9D9", ink: "#3a2626", darkBg: "#2a2020", darkChrome: "#332626", darkInk: "#f0dada" },
  { name: "purple", dot: "#8B5CF6", bg: "#F3EEFB", chrome: "#E8DEF8", ink: "#2f2840", darkBg: "#221f2c", darkChrome: "#2b2738", darkInk: "#e3dbf3" },
  { name: "blue",   dot: "#4A90D9", bg: "#EAF1FB", chrome: "#D8E6F6", ink: "#243140", darkBg: "#1c2530", darkChrome: "#24303c", darkInk: "#d6e4f3" },
  { name: "teal",   dot: "#38B2AC", bg: "#E7F6F5", chrome: "#D2EEEC", ink: "#22383a", darkBg: "#1a2624", darkChrome: "#22302e", darkInk: "#d2ebe9" },
  { name: "green",  dot: "#5FA85F", bg: "#EEF6EA", chrome: "#DDEED4", ink: "#283a26", darkBg: "#1f2a1d", darkChrome: "#273324", darkInk: "#dbeed4" },
];

export const PALETTE_ORDER: ColorName[] = PALETTE.map((s) => s.name);

export function swatch(name: ColorName): Swatch {
  return PALETTE.find((s) => s.name === name) ?? PALETTE[0];
}

/** Resolve the CSS custom-property values for a swatch in the active theme. */
export function themeVars(s: Swatch, dark: boolean) {
  return dark
    ? { bg: s.darkBg, chrome: s.darkChrome, ink: s.darkInk, dot: s.dot }
    : { bg: s.bg, chrome: s.chrome, ink: s.ink, dot: s.dot };
}

/** Pick the next palette color not already used (falls back to cycling). */
export function nextColor(used: ColorName[]): ColorName {
  const free = PALETTE_ORDER.find((c) => !used.includes(c));
  if (free) return free;
  return PALETTE_ORDER[used.length % PALETTE_ORDER.length];
}
