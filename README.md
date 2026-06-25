# Tat2

**Always-there quick sketchpads that just never lose your text.**

[![CI](https://github.com/moonspark316/tat2/actions/workflows/ci.yml/badge.svg)](https://github.com/moonspark316/tat2/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/moonspark316/tat2)](https://github.com/moonspark316/tat2/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8DB)](https://v2.tauri.app/)

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
CI. Auto-update artifacts are **off by default** so releases build without a
signing key. For maintainers, turning on signed updates takes two steps:

1. Add two GitHub Actions secrets:

   | Secret | Value |
   | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key file |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password set when the key was generated |

2. Set `bundle.createUpdaterArtifacts: true` in `src-tauri/tauri.conf.json`.

The matching **public** key is already committed in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); rotating the key means regenerating the pair
(`pnpm tauri signer generate`) and updating both. **Note:** enabling
`createUpdaterArtifacts` *without* the secrets makes the release build fail
(it can't sign), so do both together. Until then, releases publish normal
bundles and clients simply find no update.

> The updater's minisign signature is independent of OS code-signing. Until
> macOS notarization lands (the cert is still pending), macOS users get the same
> unsigned-app first-launch step on each update as they do on a fresh install.

### macOS signing & notarization

Releases are unsigned until Tat2's **own** Apple Developer ID is configured —
then Gatekeeper opens the app with no warning. The CI is already wired; it signs
+ notarizes automatically once these repo secrets are present (absent = unsigned
build, no failure):

| Secret | How to get it |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of a **Developer ID Application** cert exported as `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: <Your Name/Org> (TEAMID)` |
| `APPLE_ID` | the Apple ID email of the account that owns the cert |
| `APPLE_PASSWORD` | an [app-specific password](https://support.apple.com/en-us/102654) for notarization |
| `APPLE_TEAM_ID` | your 10-char Apple Developer Team ID |

Prereqs (one-time): an **Apple Developer Program** membership ($99/yr) under the
project's account, then create a *Developer ID Application* certificate at
[developer.apple.com](https://developer.apple.com/account/resources/certificates).
This is the only Gatekeeper-clean path; an "Apple Development" cert can't notarize
for distribution.

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

## Contributing

Contributions are welcome! Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** for
setup and the checks CI runs, and **[ARCHITECTURE.md](ARCHITECTURE.md)** for how
the Rust core, Tauri bridge, and React frontend fit together. Please be kind —
see the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? See
[SECURITY.md](SECURITY.md).

Good first stops: issues labelled **good-first-issue**, and the roadmap above.

---

## License

MIT (see `LICENSE`).
