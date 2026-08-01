import { useLayoutEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A menu entry is either an actionable item or a visual divider. */
export type MenuEntry = MenuItem | "separator";

interface ContextMenuProps {
  /** Cursor anchor (viewport coords from the triggering `contextmenu` event). */
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

/**
 * A lightweight right-click menu. Rendered at the cursor, closes on any outside
 * mousedown, on Escape, or after an item fires. Nudges itself back on-screen if
 * it would overflow the (small, frameless) window. Presentational only — all
 * mutations happen in the item `onClick`s the caller supplies.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Clamp into the viewport after layout so it never spills off the popover.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (r.right > window.innerWidth) nx = Math.max(4, window.innerWidth - r.width - 4);
    if (r.bottom > window.innerHeight)
      ny = Math.max(4, window.innerHeight - r.height - 4);
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  }, [x, y]);

  return (
    <div
      className="ctx-backdrop"
      onMouseDown={onClose}
      // Swallow a second right-click (and its native menu) onto the backdrop.
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="ctx-menu"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={`sep-${i}`} className="ctx-sep" />
          ) : (
            <button
              key={it.label}
              className={`ctx-item ${it.danger ? "danger" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                it.onClick();
                onClose();
              }}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
