# CLAUDE.md — Tat2

Guidance for working in this repo.

## What this is

A cross-platform (macOS/Windows/Linux) menu-bar **quick-sketchpad** app. The
product promise is: instant access + invisible, never-failing saves + revision
history + multiple colored pads for organization. Read `README.md` for the
full pitch and architecture.

## Stack

- **Tauri v2** desktop shell (Rust) — `src-tauri/`
- **React 19 + TypeScript + Vite** frontend — `src/`
- Package manager: **pnpm**

## Layout

```
src/                  React frontend
  App.tsx             top-level composition: theme, global keys, overlay wiring
  hooks/useWorkspace.ts  owns pads/contents/active-selection state + AutoSaver
  components/         presentational UI — TopBar, Editor, StatusBar, FindBar,
                      SearchOverlay, RevisionBrowser, TrashView, SettingsPanel,
                      MarkdownView
  lib/                pure logic (unit-tested): diff, search, shortcut, text
  storage.ts          invoke() wrappers + AutoSaver (debounced invisible saves)
  palette.ts          the 7-color pad palette + theming helpers
  types.ts            shared TS types mirroring the Rust structs
src-tauri/
  src/lib.rs          tray icon, global shortcut, frameless popover positioning,
                      hide-on-blur, accessory activation policy
  src/storage.rs      atomic Markdown/JSON persistence + revision snapshots,
                      all Tauri #[command]s
  capabilities/       Tauri ACL permissions for the main window
  tauri.conf.json     window = frameless, transparent, hidden, always-on-top
```

## Non-negotiable product rules

1. **Never show a save indicator.** No "Saving…", "Saved", dirty dots, or Save
   buttons. Persistence is always silent. If you think the user needs
   reassurance, you're solving the wrong problem.
2. **Saving must never lose data.** All writes go through the atomic
   temp→fsync→rename helper in `storage.rs`. Don't introduce non-atomic writes.
   Flush pending edits on blur/hide/quit (`AutoSaver.flushAll`).
3. **Pads are the unit of organization** — not folders, not tags (yet). Each pad
   has a color from `palette.ts`.
4. **Plain Markdown is the source of truth.** Keep `pads/<id>.md` human-readable
   and editor-recoverable. Any richer format must mirror to `.md`.

## Conventions

- Keep the TS types in `src/types.ts` in sync with the serde structs in
  `storage.rs` (note the `#[serde(rename = ...)]` camelCase mappings).
- Tauri command argument keys passed from JS are camelCase and map to the Rust
  snake_case params automatically.
- New Rust commands must be added to the `generate_handler!` list in `lib.rs`
  AND wrapped in `src/storage.ts`.
- Window operations are done in Rust where possible; JS window calls need a
  matching `core:window:*` permission in `capabilities/default.json`.

## Build / verify

```bash
pnpm install
pnpm typecheck                 # tsc --noEmit
pnpm tauri dev                 # run app
(cd src-tauri && cargo check)  # Rust check
```

## Workflow

Work is organized as GitHub **epics + issues** on the `moonspark316/tat2`
private repo. When implementing, reference the relevant issue and keep the
roadmap in `README.md` honest about what's actually done.
