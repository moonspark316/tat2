/**
 * In-memory store of per-pad Automerge documents (issue #16).
 *
 * This is the single owner of the live CRDT for each pad. The React layer keeps
 * working with plain `string` content for the editor; the store sits behind the
 * autosave path and translates each saved text into an Automerge change, then
 * persists the `.automerge` binary together with its `.md` mirror.
 *
 * It also performs the non-destructive migration: a pad that arrives from disk
 * with `.md` text but no `.automerge` binary is seeded into a fresh doc here.
 */

import type { Workspace } from "../types";
import { savePadDocNow } from "../storage";
import {
  docHistory,
  getText,
  loadDoc,
  mergeBytes,
  type PadDoc,
  type PadRevision,
  saveDoc,
  seedDoc,
  setText,
} from "./padDoc";

export class PadDocStore {
  private docs = new Map<string, PadDoc>();
  /** Test seam: defaults to the deterministic device actor id. */
  private actor?: string;

  constructor(actor?: string) {
    this.actor = actor;
  }

  /**
   * Hydrate the store from a loaded workspace. For each pad:
   *   - if a `.automerge` binary exists, load it (preserving full history);
   *   - otherwise seed a fresh doc from the `.md` text (migration).
   *
   * Returns the set of pad ids that were freshly migrated (had no binary yet)
   * so the caller can persist their new `.automerge` once, making the migration
   * durable. Migration is non-destructive: the `.md` is never rewritten here, so
   * a seeded doc whose text equals the `.md` leaves the `.md` byte-identical.
   */
  hydrate(workspace: Workspace): string[] {
    const migrated: string[] = [];
    for (const pad of workspace.index.pads) {
      const id = pad.id;
      const bytes = workspace.docs[id];
      const mdText = workspace.contents[id] ?? "";
      if (bytes && bytes.length > 0) {
        let doc = loadDoc(Uint8Array.from(bytes), this.actor);
        // `.md` is the source of truth. If the binary lagged behind it (e.g. a
        // crash after the `.md` write but before the `.automerge` write — the
        // `.md` is written first by design), fold the recoverable `.md` text
        // back into the doc so the user's words are never silently reverted,
        // and flag the pad so its healed binary is re-persisted once.
        if (getText(doc) !== mdText) {
          doc = setText(doc, mdText, this.actor);
          migrated.push(id);
        }
        this.docs.set(id, doc);
      } else {
        this.docs.set(id, seedDoc(mdText, this.actor));
        migrated.push(id);
      }
    }
    return migrated;
  }

  /** Whether the store is tracking a doc for `id`. */
  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** Current text of a pad's doc (empty string if unknown). */
  text(id: string): string {
    const doc = this.docs.get(id);
    return doc ? getText(doc) : "";
  }

  /** Ensure a doc exists for `id`, seeding from `text` if it's new. */
  ensure(id: string, text = ""): void {
    if (!this.docs.has(id)) {
      this.docs.set(id, seedDoc(text, this.actor));
    }
  }

  /** Drop a pad's doc from memory (e.g. after it's trashed). */
  forget(id: string): void {
    this.docs.delete(id);
  }

  /** Adopt a doc directly from its binary (e.g. restoring from trash). */
  adoptBytes(id: string, bytes: number[] | Uint8Array): void {
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.docs.set(id, loadDoc(arr, this.actor));
  }

  /**
   * Apply a new full-text value to a pad's doc and return the bytes to persist
   * plus the canonical text (post-change). Seeds the doc if it's new.
   */
  applyEdit(id: string, text: string): { bytes: Uint8Array; content: string } {
    this.ensure(id, "");
    const next = setText(this.docs.get(id)!, text, this.actor);
    this.docs.set(id, next);
    return { bytes: saveDoc(next), content: getText(next) };
  }

  /**
   * Merge another device's serialized doc into a pad (the synced-folder / relay
   * reconcile path). Returns the converged text, or null if the pad is unknown.
   */
  merge(id: string, bytes: number[] | Uint8Array): string | null {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const merged = mergeBytes(doc, arr);
    this.docs.set(id, merged);
    return getText(merged);
  }

  /** The serialized binary for a pad, for persisting / sending. */
  bytes(id: string): Uint8Array | null {
    const doc = this.docs.get(id);
    return doc ? saveDoc(doc) : null;
  }

  /** A pad's revision history derived from Automerge (#11/#15 can adopt this). */
  history(id: string): PadRevision[] {
    const doc = this.docs.get(id);
    return doc ? docHistory(doc) : [];
  }

  /**
   * A {@link PersistFn} bound to this store: folds the saved text into the pad's
   * Automerge doc, then writes the binary + `.md` mirror atomically in Rust.
   * Wire this into the {@link AutoSaver} so every invisible save is CRDT-backed.
   */
  persistFn = (id: string, content: string): Promise<void> => {
    const { bytes, content: canonical } = this.applyEdit(id, content);
    return savePadDocNow(id, bytes, canonical);
  };
}
