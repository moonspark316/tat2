# Tat2

**Always-there quick sketchpads that just never lose your text.**

Tat2 lives in your menu bar / system tray. Hit a global shortcut, a small
colorful pad drops down, you type, you click away. It saves itself — invisibly,
atomically, with full revision history. No "Saving…", no "Saved", no Save button.
It simply never fails.

Keep as many sketchpads as you like, each one its own color, so notes stay
organized however your brain wants them.

> The name is a pun: **tat2 → "tattoo"** — things you jot down and keep.

---

## Why it exists

Most note apps make you think about saving, files, folders, and sync status.
Tat2's entire premise is the opposite: **the fastest possible path from "I need
to write this down" to it being safely written down forever**, on every desktop
OS.

Design pillars:

1. **Instant access** — menu-bar icon + global hotkey. One keystroke to write.
2. **Invisible persistence** — debounced, atomic, crash-safe writes. Never a
   spinner, never a lost keystroke.
3. **Revisions for free** — every meaningful change is snapshotted; you can roll
   back in time.
4. **Organize by pad** — multiple colored sketchpads instead of folders.
5. **Cross-platform** — macOS, Windows, Linux from one codebase.

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | **Tauri v2** (Rust) | Tiny native binaries, first-class tray + global-shortcut, runs on macOS/Windows/Linux |
| UI | **React 19 + TypeScript + Vite** | Fast, familiar, maintainable |
| Storage | **Rust, plain Markdown + JSON** | Source of truth is human-readable text; atomic temp→fsync→rename writes can't corrupt |
| History | **Append-only snapshots** on disk | Throttled point-in-time revisions, pruned to a cap |
| Sync *(roadmap)* | **Automerge 3 CRDT** | Conflict-free merge + git-like history → real multi-device sync that never conflicts |

### Storage layout

Under the OS app-data dir (e.g. `~/Library/Application Support/com.moonspark.tat2`):

```
workspace/
  index.json            ordered pad metadata + active pad + settings
  pads/<id>.md          current content of each pad (the source of truth)
  history/<id>/<ms>.md  point-in-time revision snapshots
```

Because pads are plain `.md`, your notes are recoverable with any text editor,
and the folder can be dropped into iCloud/Dropbox/Syncthing as a stop-gap sync
until native CRDT sync lands.

---

## Run it

Prerequisites: **Node 18+**, **pnpm**, **Rust 1.77+**, and the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev      # run the desktop app in dev
pnpm tauri build    # produce a native installer for the current OS
```

The app has no dock/taskbar window — look for the **Tat2 icon in your menu bar /
system tray**, or press the global shortcut:

- macOS: `⌘ + ⇧ + Space`
- Windows / Linux: `Ctrl + Shift + Space`

---

## Roadmap

Tracked as GitHub epics & issues. Highlights:

- **Foundation** — tray + shortcut + frameless popover *(done in MVP)*
- **Persistence & history** — atomic autosave *(done)*, in-app revision browser
- **Sync** — Automerge document model, end-to-end-encrypted relay, multi-device
- **UX** — markdown rendering, search across pads, drag-reorder, themes
- **Cross-platform polish** — tray positioning per-OS, auto-update, signing
- **Release** — code signing/notarization, installers, CI

---

## License

MIT (see `LICENSE`).
