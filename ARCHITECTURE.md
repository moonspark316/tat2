# Architecture

Tat2 is a [Tauri v2](https://v2.tauri.app/) desktop app: a **Rust core** for the
native shell and storage, and a **React + TypeScript** frontend for the UI. They
talk over Tauri's IPC bridge.

```
┌─────────────────────────────  React frontend (src/)  ─────────────────────────────┐
│  App.tsx ── composition: theme, global keys, overlay wiring                        │
│    │                                                                               │
│    ├─ hooks/useWorkspace.ts ── owns pads / contents / active selection + AutoSaver │
│    ├─ components/ ── presentational UI (TopBar, Editor, overlays, …)               │
│    └─ lib/ ── pure, unit-tested logic (diff, search, shortcut, text)               │
│                          │                                                         │
│                    storage.ts ── thin invoke() wrappers + the AutoSaver engine     │
└──────────────────────────┼─────────────────────────────────────────────────────────┘
                           │  Tauri IPC (camelCase args ↔ snake_case Rust params)
┌──────────────────────────┼──────────────────────  Rust core (src-tauri/src/)  ─────┐
│   lib.rs ── tray icon, global shortcut, frameless popover positioning,             │
│             hide-on-blur, accessory activation policy, before-quit flush           │
│   storage.rs ── all #[command]s: atomic Markdown/JSON persistence,                 │
│                 revision snapshots, trash/restore                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
                                      │
                            workspace/ on disk (per-OS app-data dir)
```

## Storage model (`src-tauri/src/storage.rs`)

The **source of truth is plain text on disk**, so notes survive the app:

```
workspace/
  index.json            ordered pad metadata + active pad + settings
  pads/<id>.md          current content of each pad
  history/<id>/<ms>.md  throttled point-in-time revision snapshots
  trash/                soft-deleted pads (recoverable)
```

Key invariants:

- **Atomic writes.** `atomic_write` writes to a temp sibling, `fsync`s, then
  renames over the target — a crash or power loss can never corrupt a pad.
- **Revisions for free.** Meaningful changes are snapshotted (throttled, pruned
  to a cap). `force_snapshot` is used before destructive actions.
- **Trash never loses data.** Deletes move files to `trash/`; even pads with
  corrupt/missing metadata are still listable and restorable.

## The save path (why there's no "Saving…")

1. You type → `useWorkspace.edit` updates React state and calls
   `AutoSaver.queue(id, content)`.
2. `AutoSaver` (in `storage.ts`) debounces rapid keystrokes into one write per
   pad, preserves write ordering, and retries silently on failure.
3. On blur / hide / quit, `AutoSaver.flushAll()` persists everything pending and
   awaits in-flight writes, so nothing is ever lost.

There is intentionally **no save UI** — saving just always works.

## The native shell (`src-tauri/src/lib.rs`)

- A **tray icon** + a configurable **global shortcut** summon a frameless,
  transparent, always-on-top popover, positioned under the tray icon.
- The window **hides on blur** unless pinned, and "closing" it just hides it
  (quit is via the tray).
- On macOS the app uses the **Accessory** activation policy — no dock icon.
- Window operations live in Rust where possible; JS window calls need a matching
  `core:window:*` permission in `src-tauri/capabilities/`.

## Frontend conventions

- `App.tsx` is composition only; workspace state lives in `useWorkspace`,
  presentational pieces in `components/`, pure logic in `lib/` (with tests).
- Every Tauri command gets a typed wrapper in `storage.ts`.
- `src/types.ts` mirrors the serde structs in `storage.rs`.

## Roadmap (not yet built)

Sync (Automerge CRDT — see [docs/SYNC_DESIGN.md](docs/SYNC_DESIGN.md)),
cross-platform tray/positioning polish, and signed/auto-updating releases.
