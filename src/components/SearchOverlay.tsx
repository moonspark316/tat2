import { useEffect, useMemo, useRef, useState } from "react";
import type { PadMeta } from "../types";
import { swatch } from "../palette";
import { searchAllPads } from "../lib/search";

interface SearchOverlayProps {
  pads: PadMeta[];
  contents: Record<string, string>;
  onJump: (padId: string, offset: number, length: number) => void;
  onClose: () => void;
}

export function SearchOverlay({
  pads,
  contents,
  onJump,
  onClose,
}: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(
    () => searchAllPads(pads, contents, query),
    [pads, contents, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const jump = (i: number) => {
    const h = hits[i];
    // Use the hit's own matched length, not `query.length`: lowercasing isn't
    // always length-preserving, so the highlighted span must come from the
    // match itself or it would be misaligned in the editor (#30).
    if (h) onJump(h.padId, h.offset, h.length);
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search all sketchpads"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter") jump(active);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
          }}
        />
        <div className="search-results">
          {query && hits.length === 0 ? (
            <div className="search-empty">No matches</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.padId}-${h.lineNo}-${i}`}
                className={`search-hit ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => jump(i)}
              >
                <span
                  className="hit-dot"
                  style={{ background: swatch(h.color).dot }}
                />
                <span className="hit-label">{h.label}</span>
                <span className="hit-snippet">{h.snippet}</span>
                <span className="hit-line">:{h.lineNo}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
