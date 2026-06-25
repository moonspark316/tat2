import type { PadMeta } from "../types";
import { padLabel } from "./text";

export interface Match {
  start: number;
  end: number;
}

/**
 * All case-insensitive, non-overlapping substring matches of `query` in `text`.
 *
 * Offsets are reported against the ORIGINAL `text` (UTF-16 code-unit indices),
 * which is what the editor's `setSelectionRange` expects. We can't just
 * `indexOf` into `text.toLowerCase()` because `String.toLowerCase()` is not
 * length-preserving for every code point — e.g. "İ" (U+0130) lowercases to two
 * code units ("i̇"). Lowercasing the whole haystack would shift every
 * subsequent index. Instead we lowercase per starting position and measure how
 * many ORIGINAL code units a match consumed, so `text.slice(start, end)` always
 * returns the matched original text.
 */
export function findMatches(text: string, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const needle = query.toLowerCase();
  for (let start = 0; start <= text.length; ) {
    // Grow a window over the original text until its lowercase form is at least
    // as long as the needle, then test for a prefix match. This keeps offsets in
    // original-text space even when lowercasing changes length.
    let consumed = 0;
    let lowered = "";
    let matched = false;
    while (start + consumed <= text.length && lowered.length < needle.length) {
      consumed++;
      lowered = text.slice(start, start + consumed).toLowerCase();
    }
    if (lowered.length >= needle.length && lowered.startsWith(needle)) {
      matched = true;
      // Trim trailing original units that only contributed extra lowercase
      // length beyond the needle (so `end` is the tightest original span).
      while (
        consumed > 1 &&
        text.slice(start, start + consumed - 1).toLowerCase().startsWith(needle)
      ) {
        consumed--;
      }
    }
    if (matched) {
      matches.push({ start, end: start + consumed });
      start += consumed; // non-overlapping
    } else {
      start++;
    }
  }
  return matches;
}

export interface PadHit {
  padId: string;
  label: string;
  color: PadMeta["color"];
  lineNo: number; // 1-based
  /** First character offset of the match within the whole pad content. */
  offset: number;
  /**
   * Length of the matched span in the ORIGINAL content (UTF-16 code units).
   * May differ from `query.length` when lowercasing changes length, so this is
   * what callers must use to highlight/select — not `query.length` (#30).
   */
  length: number;
  snippet: string;
}

/** Find matching lines across every pad (case-insensitive). */
export function searchAllPads(
  pads: PadMeta[],
  contents: Record<string, string>,
  query: string,
  perPadLimit = 20,
): PadHit[] {
  if (!query.trim()) return [];
  const needle = query.toLowerCase();
  const hits: PadHit[] = [];
  for (const pad of pads) {
    const content = contents[pad.id] ?? "";
    const label = padLabel(pad.title, content);
    const lines = content.split("\n");
    let offset = 0;
    let found = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Locate the match against the original line (via findMatches, which is
      // careful about offsets) rather than indexing into the lowercased string.
      // `String.toLowerCase()` is not length-preserving for some code points
      // (e.g. "İ".toLowerCase() is two units), so an index into the lowercased
      // line would not line up with the original-text offset the editor needs.
      const [m] = findMatches(line, needle);
      if (m && found < perPadLimit) {
        hits.push({
          padId: pad.id,
          label,
          color: pad.color,
          lineNo: i + 1,
          offset: offset + m.start,
          length: m.end - m.start,
          snippet: line.trim().slice(0, 80) || "(blank line)",
        });
        found++;
      }
      offset += line.length + 1; // +1 for the consumed "\n"
    }
  }
  return hits;
}
