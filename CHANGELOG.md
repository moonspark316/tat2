# Changelog

All notable changes to Tat2 are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-25

First production-quality build — the "Working MVP". A menu-bar quick-sketchpad
with instant access, invisible never-fail saves, revision history, and multiple
colored pads.

### Added
- Menu-bar / system-tray icon + configurable global shortcut summon a frameless
  popover (`⌘⇧Space` / `Ctrl+Shift+Space`).
- Multiple colored sketchpads — add, switch, drag-reorder, inline rename, recolor.
- Invisible, atomic, crash-safe autosave (no save UI, ever); flush on blur/quit.
- Revision history browser with line-level **diff** and one-click restore.
- **Trash** with restore / permanent delete; corruption-tolerant recovery of
  orphaned content.
- Find-in-pad (`⌘F`) and search across all pads (`⌘⇧F`).
- Light / dark / system theme; adjustable text size.
- Sanitized Markdown preview; export / import pads.
- Launch-at-login; pin-to-keep-open; remembers window size.
- Layout-independent keyboard shortcuts (`⌘N`, `⌘1‑9`, `⌘[`/`⌘]`, `Esc`).
- Tagged release CI producing unsigned macOS (universal) + Linux (`.deb`/`.rpm`)
  bundles.

### Hardening (pre-release audit + code review)
- `Esc` closes an open History/Trash/Settings overlay instead of hiding the
  whole window.
- Editor shortcuts no longer fire behind an open modal.
- Markdown preview can't navigate the popover away: the sanitizer drops every
  self-navigating element (`form`/`input`/`area`/`base`/embedders) and surviving
  `<a>` clicks (any button) open in the OS browser; in-page anchors still scroll.
- Trash never silently loses data — pads with corrupt/missing metadata are still
  listed and restorable.
- Shortcuts match physical key position, so they survive non-US layouts.

### Known limitations
- Bundles are **unsigned** (Gatekeeper/SmartScreen prompts on first launch).
- **Windows** installers and **auto-update** are not yet shipped.
- Linux **AppImage** is not built (the release runner lacks `xdg-utils`).
- **Sync** (Automerge CRDT) is designed but not implemented — see
  [docs/SYNC_DESIGN.md](docs/SYNC_DESIGN.md).

[1.0.0]: https://github.com/moonspark316/tat2/releases/tag/v1.0.0
