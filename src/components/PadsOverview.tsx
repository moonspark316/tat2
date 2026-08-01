import { useEffect, useMemo, useRef, useState } from "react";
import type { PadMeta } from "../types";
import { swatch } from "../palette";
import { searchAllPads } from "../lib/search";
import { firstLine, formatRevision, padLabel } from "../lib/text";

interface PadsOverviewProps {
  /** The FULL pad list (archived pads are shown in their own section). */
  pads: PadMeta[];
  contents: Record<string, string>;
  activeId: string | null;
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onClose: () => void;
}

/**
 * OneTab-style "All sketchpads" overview (#68). Reuses the SearchOverlay /
 * TrashView shell (`.search-backdrop` / `.search` + `.hit-*` rows). Shows two
 * ordered sections — Active (visible) and Archived — with an optional filter.
 * Opening an archived pad selects it WITHOUT auto-unarchiving it.
 */
export function PadsOverview({
  pads,
  contents,
  activeId,
  onOpen,
  onArchive,
  onUnarchive,
  onClose,
}: PadsOverviewProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useMemo(() => Date.now(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // How many pads are visible (non-archived) — archiving is disabled when this
  // would drop to zero (the strip must never be empty).
  const visibleCount = useMemo(
    () => pads.filter((p) => !p.archived).length,
    [pads],
  );

  // Filter helper: keep a pad if its content matches (via the offset-correct
  // searchAllPads) OR its label matches, so titled/empty pads still filter.
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return null; // null => show all
    const ql = q.toLowerCase();
    return (p: PadMeta) => {
      const content = contents[p.id] ?? "";
      if (searchAllPads([p], contents, q).length > 0) return true;
      return padLabel(p.title, content).toLowerCase().includes(ql);
    };
  }, [query, contents]);

  const activePads = useMemo(() => {
    const list = pads.filter((p) => !p.archived);
    list.sort((a, b) => a.order - b.order);
    return matches ? list.filter(matches) : list;
  }, [pads, matches]);

  const archivedPads = useMemo(() => {
    const list = pads.filter((p) => p.archived);
    list.sort((a, b) => a.order - b.order);
    return matches ? list.filter(matches) : list;
  }, [pads, matches]);

  // A single flat, ordered list of ids for keyboard navigation across sections.
  const rowIds = useMemo(
    () => [...activePads, ...archivedPads].map((p) => p.id),
    [activePads, archivedPads],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  const open = (i: number) => {
    const id = rowIds[i];
    if (id) {
      onOpen(id);
      onClose();
    }
  };

  const renderRow = (p: PadMeta, i: number) => {
    const content = contents[p.id] ?? "";
    const label = padLabel(p.title, content);
    const snippet = firstLine(content) || formatRevision(p.updatedAt, now);
    const isActivePad = p.id === activeId;
    const archived = !!p.archived;
    const s = swatch(p.color);
    return (
      <button
        key={p.id}
        className={`search-hit pads-row ${i === active ? "active" : ""} ${
          isActivePad ? "current" : ""
        } ${archived ? "archived" : ""}`}
        onMouseEnter={() => setActive(i)}
        onClick={() => open(i)}
      >
        <span
          className="hit-dot"
          style={
            archived
              ? { background: "transparent", border: `2px solid ${s.dot}` }
              : { background: s.dot }
          }
        />
        <span className="hit-label">{label}</span>
        <span className="hit-snippet">{snippet}</span>
        {archived ? (
          <span
            className="pads-action"
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onUnarchive(p.id);
            }}
          >
            Unarchive
          </span>
        ) : (
          <span
            className={`pads-action ${visibleCount <= 1 ? "disabled" : ""}`}
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              if (visibleCount > 1) onArchive(p.id);
            }}
          >
            Archive
          </span>
        )}
      </button>
    );
  };

  const empty = activePads.length === 0 && archivedPads.length === 0;

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Filter sketchpads"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter") open(active);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, rowIds.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
          }}
        />
        <div className="search-results">
          {empty ? (
            <div className="search-empty">No pads</div>
          ) : (
            <>
              {activePads.length > 0 ? (
                <>
                  <div className="trash-head">Active</div>
                  {activePads.map((p, idx) => renderRow(p, idx))}
                </>
              ) : null}
              {archivedPads.length > 0 ? (
                <>
                  <div className="trash-head">Archived</div>
                  {archivedPads.map((p, idx) =>
                    renderRow(p, activePads.length + idx),
                  )}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
