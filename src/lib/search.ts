import type { PadMeta } from "../types";
import { padLabel } from "./text";

export interface Match {
  start: number;
  end: number;
}

/** All case-insensitive substring matches of `query` in `text`. */
export function findMatches(text: string, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    matches.push({ start: i, end: i + needle.length });
    from = i + needle.length;
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
      const idx = line.toLowerCase().indexOf(needle);
      if (idx !== -1 && found < perPadLimit) {
        hits.push({
          padId: pad.id,
          label,
          color: pad.color,
          lineNo: i + 1,
          offset: offset + idx,
          snippet: line.trim().slice(0, 80) || "(blank line)",
        });
        found++;
      }
      offset += line.length + 1; // +1 for the consumed "\n"
    }
  }
  return hits;
}
