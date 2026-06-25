# Tat2 Sync — Design (Epic E3)

Status: **partially implemented.** The offline-verifiable core has landed:
#16 (Automerge model), #21 (merge test suite), #20 (synced-folder stop-gap
backend). The networked pieces (#17 engine, #18 relay, #19 pairing) remain
design-only. This document anchors issues #16–#21 and is kept honest about
what's actually built.

## Goals

1. A user's pads sync across **their own** devices (macOS/Windows/Linux).
2. **Offline-first**: every device works fully offline; sync is a background
   reconciliation, never a blocking operation. Consistent with the product rule
   that saving is invisible and never fails.
3. **Conflict-free**: concurrent edits on two devices merge without clobbering.
4. **End-to-end encrypted**: the relay server never sees plaintext notes.
5. No heavyweight account system if avoidable.

## Why CRDT (Automerge) — #16

Pads are currently plain strings persisted to `pads/<id>.md`. To merge
concurrent edits without a "last write wins" data-loss cliff, each pad's content
becomes an **Automerge document** (`@automerge/automerge`, v3 — Rust core, small
memory footprint).

- Automerge gives **conflict-free merge** and a **git-like change history** for
  free — which also subsumes the snapshot-based revision history we ship today
  (#11/#15 can migrate to `Automerge.getHistory()`).
- We keep mirroring each pad to `pads/<id>.md` on every change so notes stay
  recoverable in any text editor and the folder stays human-meaningful. The
  Automerge binary lives alongside as `pads/<id>.automerge`.

Migration: on first launch after the upgrade, wrap each existing `.md` string in
a fresh Automerge doc (single initial change). No data loss; old `.md` becomes
the seed.

Open question: text CRDT granularity. Use `Automerge.Text`/`splice` on a single
`content` field so character-level edits merge (not whole-string replace).

> **Resolved (implementation note):** in Automerge **v3** the `Automerge.Text`
> class no longer exists — a plain JS `string` field IS a character-level text
> CRDT, edited with `Automerge.splice` / `Automerge.updateText`. We therefore use
> a single `content: string` field and diff each saved value into splices. This
> is the v3-correct realization of "Text/splice on a `content` field" and merges
> per-character (see `src/automerge/padDoc.ts` and the convergence suite in
> `src/automerge/convergence.test.ts`).

## Background sync engine + offline queue — #17

A small state machine per device:

```
local edit ──> Automerge change ──> append to outbound queue (durable, on disk)
                                        │
                          (when online) ▼
                                  push changes to relay
relay delivers peers' changes ──> apply to local doc ──> mirror to .md ──> UI updates
```

- The outbound queue is an append-only log on disk so unsent changes survive a
  crash/quit. At-least-once delivery; Automerge changes are idempotent so
  re-delivery is safe.
- Sync runs on a debounced timer + on reconnect; it never blocks the editor.
- Backpressure: batch changes; compact the queue once the relay acks.

## End-to-end-encrypted relay — #18

The relay is a **dumb, encrypted change-store-and-forward**. It never decrypts.

- Per-workspace symmetric key `K` derived on the first device; shared to other
  devices only via pairing (#19). The relay only ever sees ciphertext + routing
  metadata (workspace id, device id, monotonic seq).
- Each Automerge change blob is encrypted with an AEAD (XChaCha20-Poly1305)
  under `K` before upload. Server stores `(workspaceId, seq, ciphertext)` and
  fans out to other devices of the same workspace.
- Transport: HTTPS for push/pull + a WebSocket for live fan-out. Built on Vercel
  Functions + a durable store (e.g. a Marketplace Postgres/Redis); or a tiny
  self-hostable service. The server is intentionally minimal and stateless about
  content.
- Zero-knowledge: losing the server leaks nothing; losing `K` loses access (so
  key backup/escrow is a deliberate, user-controlled choice).

## Device pairing / lightweight identity — #19

Avoid passwords. Two paths:

1. **QR / short-code pairing** (preferred): an already-set-up device displays a
   QR encoding `{relayURL, workspaceId, K}` (or a short numeric code that
   bootstraps an authenticated key exchange, e.g. SPAKE2). The new device scans
   it and joins. `K` is transferred E2E, never to the server.
2. **Sign in with Vercel / OAuth** as an optional account layer purely for
   relay authorization (who may push to a workspace), still E2E for content.

Each device has a stable `deviceId` keypair; the relay authorizes pushes by
device signature.

## Stop-gap: synced-folder backend — #20

Before the relay ships, offer an interim sync: let the user point the workspace
directory at an existing synced folder (iCloud Drive / Dropbox / Syncthing).

- Add a configurable workspace root (stored outside the workspace, e.g.
  `app_config_dir/config.json`), with a guided "move my data" flow.
- Pad writes are atomic, and #16 lands the per-pad Automerge CRDT model. That
  model is the **infrastructure** for an eventual on-launch reconcile of
  synced-folder conflict copies — it is **not yet wired** as a live conflict
  resolver in this iteration.

> **Caveat still applies (CRDT reconcile not yet wired):** the on-launch merge of
> conflict copies is infrastructure for a later issue, not shipping here.
> Concretely, `PadDocStore.hydrate` loads only the single `<id>.automerge` per
> pad and `PadDocStore.merge` has **no production caller** — nothing scans for or
> folds in a synced-folder conflict copy on launch. So the pre-#16 risk stands:
> simultaneous edits to the *same pad* on two devices conflict at the file level,
> the synced-folder tool may create a conflict copy, and the **losing device's
> unsynced edits can be lost** when the tool clobbers the file. Resolving this —
> discovering conflict copies and merging them via `PadDocStore.merge` on launch
> — is a follow-up issue, and live cross-device propagation while both apps are
> open still waits on the relay (#17/#18).

Backend implemented in this iteration: a workspace root configurable via
`get_workspace_location` / `set_workspace_root` / `clear_workspace_root`
(`src-tauri/src/storage.rs`), stored in `app_config_dir/config.json` (outside
the workspace). `set_workspace_root` copies the workspace to the new root,
switches the config pointer, then removes the old copy — source data is never
deleted before the destination is complete, and it refuses to move into a
directory that already holds a workspace.

## Conflict-free merge test suite — #21

Property/simulation tests, runnable in CI, proving no data loss:

- Generate random interleaved edit sequences on N simulated devices, apply in
  random delivery orders (including duplicates and reordering), and assert all
  devices converge to the same Automerge state.
- Assert the `.md` mirror equals the converged doc's text.
- Fuzz the encryption/queue layer: dropped, duplicated, and out-of-order blobs
  must never corrupt convergence.

## Sequencing

1. #16 Automerge model (local only) — unlocks everything; verifiable offline.
   **DONE** — `src/automerge/{padDoc,store,actor}.ts`, `.automerge` persisted
   alongside `.md` via `save_pad_doc`.
2. #21 merge tests — lock in convergence before adding a network.
   **DONE** — `src/automerge/convergence.test.ts` (seeded, reproducible).
3. #20 synced-folder stop-gap — useful sync with no server.
   **DONE (backend)** — configurable workspace root + safe "move my data" flow
   in `src-tauri/src/storage.rs`. (UI surface still to be wired in App settings.)
4. #18 relay + #17 engine — real background sync.
5. #19 pairing — multi-device onboarding.
