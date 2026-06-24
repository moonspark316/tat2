import { computeStats } from "../lib/text";

const nf = (n: number) => n.toLocaleString();

export function StatusBar({ content }: { content: string }) {
  const { lines, words, chars } = computeStats(content);
  return (
    <footer className="statusbar">
      <span className="stats">
        {nf(lines)} lines · {nf(words)} words · {nf(chars)} characters
      </span>
    </footer>
  );
}
