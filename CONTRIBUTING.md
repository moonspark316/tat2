# Contributing to Tat2

Thanks for considering a contribution! Tat2 is a small, focused desktop app —
a menu-bar quick-sketchpad with invisible, never-fail saves. This guide gets you
from clone to a green PR.

## Ground rules (the product's soul)

Tat2 has a few **non-negotiable rules**. A change that breaks one of these won't
be merged, however nice it is otherwise:

1. **Never show a save indicator.** No "Saving…", "Saved", dirty dots, or Save
   buttons. Persistence is always silent. If users seem to need reassurance,
   that's a signal to make saving *more* trustworthy, not to add UI.
2. **Saving must never lose data.** All writes go through the atomic
   temp → fsync → rename helper in `src-tauri/src/storage.rs`. No non-atomic
   writes. Pending edits flush on blur/hide/quit.
3. **Pads are the unit of organization** — not folders or tags. Each pad has a
   color from `src/palette.ts`.
4. **Plain Markdown is the source of truth.** `pads/<id>.md` stays
   human-readable and recoverable in any editor.

If you're unsure whether an idea fits, open an issue first — happy to talk it
through.

## Prerequisites

- **Node 18+** and **[pnpm](https://pnpm.io/)**
- **Rust 1.77+** (`rustup`)
- Your OS's **[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)**
  - Linux also needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
    `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `patchelf`.

## Get it running

```bash
pnpm install
pnpm tauri dev          # launch the app in dev mode
```

There's **no dock/taskbar window** — look for the Tat2 icon in your menu bar /
tray, or press the global shortcut (`⌘⇧Space` on macOS, `Ctrl+Shift+Space`
elsewhere).

## Before you open a PR

Run the same checks CI runs — all must pass:

```bash
pnpm typecheck                               # tsc --noEmit
pnpm test                                    # vitest unit suite
(cd src-tauri && cargo fmt --check)          # Rust formatting
(cd src-tauri && cargo clippy --all-targets -- -D warnings)
(cd src-tauri && cargo check)
```

If you touch Rust commands or the storage format:

- New Tauri `#[command]`s go in the `generate_handler!` list in
  `src-tauri/src/lib.rs` **and** get a wrapper in `src/storage.ts`.
- Keep `src/types.ts` in sync with the serde structs in `storage.rs` (note the
  `#[serde(rename = ...)]` camelCase mappings).
- Add a unit test under `src/lib/` or `src/*.test.ts` for any new pure logic.

## Pull requests

- Branch off `main`; keep PRs focused on one thing.
- Describe **what** changed and **why**, and how you verified it.
- Reference the issue you're closing (`Closes #123`).
- A maintainer reviews every PR — expect a friendly back-and-forth.

## Where to start

Browse the [issues](https://github.com/moonspark316/tat2/issues), especially
anything labelled **good-first-issue**. The roadmap (sync, cross-platform
polish, signed releases) lives in `README.md` and the GitHub epics.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the Rust core, Tauri bridge, and
React frontend fit together.
