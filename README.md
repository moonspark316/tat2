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

## Install

Grab a prebuilt bundle from the
[**latest release**](https://github.com/moonspark316/tat2/releases/latest):

| OS | File | First-launch note |
| --- | --- | --- |
| macOS (Apple Silicon + Intel) | `Tat2_<ver>_universal.dmg` | Unsigned — right-click → **Open** (or `xattr -dr com.apple.quarantine /Applications/Tat2.app`) |
| Linux (Debian/Ubuntu) | `Tat2_<ver>_amd64.deb` | `sudo dpkg -i Tat2_*.deb` |
| Linux (Fedora/RHEL) | `Tat2-<ver>-1.x86_64.rpm` | `sudo rpm -i Tat2-*.rpm` |

> Windows installers aren't published yet — the release CI is wired for them but
> needs hosted-runner billing enabled. Build from source in the meantime.

### Auto-update

Tat2 quietly checks for a new signed build shortly after launch, downloads it in
the background, and — only once it's downloaded and its **minisign** signature
verifies — shows a small dismissible *"Update ready — restart"* pill. There's no
spinner, no "checking…" toast, and no version-behind badge; you can also trigger
a manual check from **Settings → Updates**.

The update feed is the GitHub release manifest at
`releases/latest/download/latest.json`, signed with the updater's private key in
CI. For maintainers, releasing signed updates needs two GitHub Actions secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password set when the key was generated |

The matching **public** key is committed in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); rotating the key means regenerating the pair
(`pnpm tauri signer generate`) and updating both. Without the secrets the release
build still succeeds but produces no signed `latest.json`, so clients simply find
no update.

> The updater's minisign signature is independent of OS code-signing. Until
> macOS notarization lands (the cert is still pending), macOS users get the same
> unsigned-app first-launch step on each update as they do on a fresh install.

## Run from source

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

## What works today

- Menu-bar/tray icon + configurable global shortcut summon a frameless popover
- Multiple colored sketchpads — add, switch, drag-reorder, inline rename, recolor
- Invisible, atomic, crash-safe autosave (no save UI, ever); flush on quit
- Revision history browser with line-level **diff** and one-click restore
- **Trash** with restore / permanent delete — deleting never loses data
- Find-in-pad (`⌘F`) and search across all pads (`⌘⇧F`)
- Light / dark / system theme; adjustable text size
- Markdown preview (sanitized); export / import pads
- Launch-at-login; pin-to-keep-open; remembers window size
- Quiet background **auto-update** with signed release feed + restart-to-apply
- Keyboard: `⌘N` new · `⌘1‑9` switch · `⌘[`/`⌘]` prev/next · `Esc` hide

## Roadmap

Tracked as GitHub epics & issues.

- **Sync** *(partly built — see [docs/SYNC_DESIGN.md](docs/SYNC_DESIGN.md))* —
  the offline-verifiable core has landed: each pad is now an **Automerge CRDT**
  (`pads/<id>.automerge` alongside the `.md` mirror) with a seeded, reproducible
  conflict-free merge test suite, plus a configurable workspace root so the data
  folder can live in iCloud/Dropbox/Syncthing as a stop-gap. Still open: the
  offline queue, end-to-end-encrypted relay, and device pairing.
- **Cross-platform polish** — Windows/Linux tray anchoring, HiDPI/multi-monitor
  *(needs testing on those OSes)*
- **Release** — `v1.0.0` ships unsigned **macOS** (universal) + **Linux**
  (`.deb`/`.rpm`) bundles via tagged CI, with a quiet signed **auto-update**
  feed (`latest.json`); **Windows** bundles + macOS **code
  signing/notarization** are still open *(need hosted-runner billing and certs)*

---

## License

MIT (see `LICENSE`).
