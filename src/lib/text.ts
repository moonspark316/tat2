export function computeStats(text: string) {
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split("\n").length : 0;
  return { chars, words, lines };
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 40) : "Empty pad";
}

/** Display label for a pad: explicit title, else first non-empty line. */
export function padLabel(title: string, content: string): string {
  if (title && title !== "Sketchpad") return title;
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
