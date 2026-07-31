import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PadMeta } from "../types";
import { swatch } from "../palette";
import { DEFAULT_PAD_TITLE, hasExplicitTitle, padLabel } from "../lib/text";
import { computeDotFit, selectVisibleDots } from "../lib/dotFit";
import { ContextMenu, type MenuEntry } from "./ContextMenu";

interface TopBarProps {
  pads: PadMeta[];
  contents: Record<string, string>;
  activeId: string | null;
  pinned: boolean;
  hasArchived: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, title: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onArchiveMany: (ids: string[]) => void;
  onUnarchiveAll: () => void;
  onTogglePin: () => void;
  onOverview: () => void;
  onHistory: () => void;
  preview: boolean;
  onTogglePreview: () => void;
  onToggleSettings: () => void;
  onClose: () => void;
}

/** An open right-click menu: where to draw it and what to show. */
interface OpenMenu {
  x: number;
  y: number;
  items: MenuEntry[];
}

export function TopBar({
  pads,
  contents,
  activeId,
  pinned,
  hasArchived,
  onSwitch,
  onAdd,
  onRename,
  onReorder,
  onArchiveMany,
  onUnarchiveAll,
  onTogglePin,
  onOverview,
  onHistory,
  preview,
  onTogglePreview,
  onToggleSettings,
  onClose,
}: TopBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Right-click a dot → bulk-archive actions relative to that pad's position in
  // the (visible) strip order. `pads` is already the visible list, so slicing it
  // gives the pads to this pad's left/right regardless of the "+N" overflow chip.
  const openDotMenu = (e: ReactMouseEvent, pad: PadMeta, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = pads.map((p) => p.id);
    const only = pads.length <= 1;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Archive to the left",
          disabled: i === 0,
          onClick: () => onArchiveMany(ids.slice(0, i)),
        },
        {
          label: "Archive to the right",
          disabled: i === pads.length - 1,
          onClick: () => onArchiveMany(ids.slice(i + 1)),
        },
        {
          label: "Archive others",
          disabled: only,
          onClick: () => onArchiveMany(ids.filter((id) => id !== pad.id)),
        },
        "separator",
        {
          label: "Archive this pad",
          disabled: only,
          onClick: () => onArchiveMany([pad.id]),
        },
        "separator",
        { label: "Rename…", onClick: () => startRename(pad) },
      ],
    });
  };

  // Right-click the ▦ toolbar icon → whole-strip archive actions.
  const openToolbarMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const others = pads.filter((p) => p.id !== activeId).map((p) => p.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Archive all but active",
          disabled: others.length === 0,
          onClick: () => onArchiveMany(others),
        },
        {
          label: "Unarchive all",
          disabled: !hasArchived,
          onClick: onUnarchiveAll,
        },
        "separator",
        { label: "Open all sketchpads (⌘O)", onClick: onOverview },
      ],
    });
  };

  // ---- Measure the `.dots` container so the strip never overflows (#69) ----
  // Local UI state only: TopBar stays presentational (no persistence). We watch
  // the container's inner width with a ResizeObserver and recompute the fit on
  // resize; the pads-list dependency below re-measures on add/remove/archive.
  const dotsRef = useRef<HTMLDivElement>(null);
  const [dotsWidth, setDotsWidth] = useState(0);

  useLayoutEffect(() => {
    const el = dotsRef.current;
    if (!el) return;
    // Seed immediately so the first paint isn't a full unbounded strip.
    setDotsWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setDotsWidth(box.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Re-run when the pad count changes so a newly-added/removed pad re-measures
    // even if the container's own box didn't change size.
  }, [pads.length]);

  useEffect(() => {
    if (renamingId) inputRef.current?.select();
  }, [renamingId]);

  const startRename = (p: PadMeta) => {
    setRenamingId(p.id);
    // Seed the field with the existing explicit title (so the user edits it);
    // leave it blank for an untitled pad so they start from the placeholder.
    setDraft(hasExplicitTitle(p.title) ? p.title : "");
  };

  const commitRename = () => {
    // An empty field clears back to the default (auto first-line label); any
    // non-empty value is kept verbatim as an explicit title — even if it equals
    // the pad's first content line — so the user's choice persists distinctly
    // rather than collapsing into the auto-derived label (#25).
    if (renamingId) onRename(renamingId, draft.trim() || DEFAULT_PAD_TITLE);
    setRenamingId(null);
  };

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = pads.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(ids);
    setDragId(null);
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      <button
        className="icon-btn close"
        onClick={onClose}
        title="Hide (reopen with the global shortcut)"
      >
        ×
      </button>

      <div className="dots" ref={dotsRef}>
        {(() => {
          // Fit as many dots as the measured width allows, then a "+N" chip
          // (#69). Before the first measurement (width 0) render the full strip
          // so we never flash an empty strip; the layout effect corrects it on
          // the next frame.
          const visibleCount =
            dotsWidth > 0
              ? computeDotFit(pads.length, dotsWidth).visibleCount
              : pads.length;
          const orderedIds = pads.map((p) => p.id);
          const shownIds = new Set(
            selectVisibleDots(orderedIds, visibleCount, activeId),
          );
          // Preserve strip order for the shown dots (selectVisibleDots may pin
          // the active pad last, but rendering in pad order keeps drag targets
          // stable; the pinned active dot still renders because it's in the set).
          const shownPads = pads.filter((p) => shownIds.has(p.id));
          // Derive the chip count from what's actually rendered so it's always
          // exact — even when the narrow-width floor forces the active dot in
          // (which reduces the overflow by one vs. computeDotFit's raw count).
          const overflow = pads.length - shownPads.length;
          const showChip = overflow > 0;
          return (
            <>
              {shownPads.map((p) => {
                const s = swatch(p.color);
                const active = p.id === activeId;
                return (
                  <button
                    key={p.id}
                    className={`dot ${active ? "active" : ""} ${
                      dragId === p.id ? "dragging" : ""
                    }`}
                    style={{ ["--this" as string]: s.dot }}
                    title={padLabel(p.title, contents[p.id] ?? "")}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(p.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => onSwitch(p.id)}
                    onDoubleClick={() => startRename(p)}
                    onContextMenu={(e) => openDotMenu(e, p, pads.indexOf(p))}
                  />
                );
              })}
              {showChip ? (
                <button
                  className="dot-chip"
                  onClick={onOverview}
                  title={`${overflow} more sketchpads (⌘O)`}
                  aria-label={`${overflow} more sketchpads. Open all sketchpads (⌘O)`}
                >
                  +{overflow}
                </button>
              ) : null}
              <button
                className="dot add"
                onClick={onAdd}
                title="New sketchpad (⌘N)"
              >
                +
              </button>
            </>
          );
        })()}
      </div>

      <button
        className={`icon-btn md ${preview ? "on" : ""}`}
        onClick={onTogglePreview}
        title={preview ? "Edit text" : "Preview Markdown"}
      >
        {preview ? "✎" : "👁"}
      </button>
      <button
        className="icon-btn overview"
        onClick={onOverview}
        onContextMenu={openToolbarMenu}
        title="All sketchpads (⌘O) — right-click to archive"
      >
        ▦
      </button>
      <button className="icon-btn history" onClick={onHistory} title="History">
        🕘
      </button>
      <button
        className={`icon-btn pin ${pinned ? "on" : ""}`}
        onClick={onTogglePin}
        title={pinned ? "Unpin (auto-hide on blur)" : "Pin (stay open)"}
      >
        {pinned ? "📌" : "📍"}
      </button>
      <button className="icon-btn gear" onClick={onToggleSettings} title="Settings">
        ⚙
      </button>

      {renamingId ? (
        <input
          ref={inputRef}
          className="rename-input"
          value={draft}
          placeholder="Pad name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            // Keep these keys local — don't let them reach global shortcuts.
            e.stopPropagation();
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenamingId(null);
          }}
        />
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </header>
  );
}
