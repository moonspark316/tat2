import { useEffect, useRef, useState } from "react";
import type { PadMeta } from "../types";
import { swatch } from "../palette";
import { DEFAULT_PAD_TITLE, hasExplicitTitle, padLabel } from "../lib/text";

interface TopBarProps {
  pads: PadMeta[];
  contents: Record<string, string>;
  activeId: string | null;
  pinned: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, title: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onTogglePin: () => void;
  onHistory: () => void;
  preview: boolean;
  onTogglePreview: () => void;
  onToggleSettings: () => void;
  onClose: () => void;
}

export function TopBar({
  pads,
  contents,
  activeId,
  pinned,
  onSwitch,
  onAdd,
  onRename,
  onReorder,
  onTogglePin,
  onHistory,
  preview,
  onTogglePreview,
  onToggleSettings,
  onClose,
}: TopBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

      <div className="dots">
        {pads.map((p) => {
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
            />
          );
        })}
        <button className="dot add" onClick={onAdd} title="New sketchpad (⌘N)">
          +
        </button>
      </div>

      <button
        className={`icon-btn md ${preview ? "on" : ""}`}
        onClick={onTogglePreview}
        title={preview ? "Edit text" : "Preview Markdown"}
      >
        {preview ? "✎" : "👁"}
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
    </header>
  );
}
