import { useEffect, useMemo, useRef, useState } from "react";
import { findMatches } from "../lib/search";

interface FindBarProps {
  content: string;
  /** Bumped to (re-)focus the find input, e.g. when Cmd+F is pressed again. */
  focusSignal: number;
  /** Reveal a range in the editor (highlight + scroll) without taking focus. */
  onSelect: (start: number, end: number) => void;
  onClose: () => void;
}

export function FindBar({ content, focusSignal, onSelect, onClose }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => findMatches(content, query), [content, query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // Reveal the first match when the QUERY changes (find-as-you-type). Keyed on
  // `query`, NOT `matches`, so editing the pad while Find is open does not yank
  // the caret to a match on every keystroke.
  useEffect(() => {
    setCurrent(0);
    if (matches.length > 0) onSelect(matches[0].start, matches[0].end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const go = (delta: number) => {
    if (matches.length === 0) return;
    const idx = (current + delta + matches.length) % matches.length;
    setCurrent(idx);
    const m = matches[idx];
    onSelect(m.start, m.end);
  };

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in pad"
        onChange={(e) => {
          setQuery(e.target.value);
          setCurrent(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="find-count">
        {query
          ? `${matches.length ? Math.min(current, matches.length - 1) + 1 : 0}/${matches.length}`
          : ""}
      </span>
      <button onClick={() => go(-1)} title="Previous (⇧⏎)" disabled={!matches.length}>
        ↑
      </button>
      <button onClick={() => go(1)} title="Next (⏎)" disabled={!matches.length}>
        ↓
      </button>
      <button onClick={onClose} title="Close (Esc)">
        ×
      </button>
    </div>
  );
}
