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
