export function computeStats(text: string) {
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split("\n").length : 0;
  return { chars, words, lines };
}

/** Cap a string to `max` Unicode code points (never splits a surrogate pair). */
function capCodePoints(s: string, max: number): string {
  // Iterating the string yields whole code points, so an emoji or other
  // astral-plane character is kept intact instead of being cut between its two
  // UTF-16 surrogate halves (which would render as a "�" replacement char).
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? capCodePoints(line.trim(), 40) : "Empty pad";
}

/**
 * The placeholder title every pad is created with. A pad still carrying this
 * exact value is considered "untitled" and labelled from its first line.
 */
export const DEFAULT_PAD_TITLE = "Sketchpad";

/**
 * Whether a pad has an explicit, user-chosen title (as opposed to the untouched
 * default). This is the single source of truth for the title-vs-derived
 * decision so a title that merely *looks like* the first content line is still
 * treated as explicit and displayed distinctly (#25).
 */
export function hasExplicitTitle(title: string): boolean {
  return title.trim().length > 0 && title !== DEFAULT_PAD_TITLE;
}

/** Display label for a pad: explicit title, else first non-empty line. */
export function padLabel(title: string, content: string): string {
  if (hasExplicitTitle(title)) return title;
  return firstLine(content);
}

/** Human-friendly timestamp for a revision (relative for recent, else date). */
export function formatRevision(ms: number, now: number): string {
  const diff = now - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return new Date(ms).toLocaleString();
}
