<!-- Thanks for contributing to Tat2! -->

## What & why

<!-- What does this change, and what problem does it solve? -->

Closes #

## How I verified

<!-- Check what you ran. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo check` (in `src-tauri/`)
- [ ] Ran the app (`pnpm tauri dev`) and exercised the change

## Product rules

- [ ] No save indicator added; persistence stays silent
- [ ] No non-atomic writes; pending edits still flush on blur/hide/quit
- [ ] TS types in `src/types.ts` still match the Rust structs (if storage changed)

## Notes for the reviewer

<!-- Anything tricky, screenshots for UI changes, follow-ups, etc. -->
