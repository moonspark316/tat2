import { invoke } from "@tauri-apps/api/core";
import type {
  Index,
  PadMeta,
  TrashEntry,
  RestoredPad,
  Workspace,
  WorkspaceLocation,
} from "./types";

// ---- Thin wrappers over the Rust storage commands ----

export const loadWorkspace = (): Promise<Workspace> =>
  invoke("load_workspace");

export const saveIndex = (index: Index): Promise<void> =>
  invoke("save_index", { index });

export const savePadNow = (id: string, content: string): Promise<void> =>
  invoke("save_pad", { id, content });

/**
 * Persist a pad as an Automerge doc + its `.md` mirror (the primary editor
 * save path since #16). `doc` is the Automerge binary; `content` is its text.
 * Rust writes the `.md` FIRST so the human-recoverable copy is never at risk.
 */
export const savePadDocNow = (
  id: string,
  doc: Uint8Array,
  content: string,
): Promise<void> =>
  // Tauri serializes a typed array to a JSON number array for the `Vec<u8>` arg.
  invoke("save_pad_doc", { id, doc: Array.from(doc), content });

export const trashPad = (meta: PadMeta): Promise<void> =>
  invoke("trash_pad", { meta });

export const listTrash = (): Promise<TrashEntry[]> => invoke("list_trash");

export const restorePad = (id: string): Promise<RestoredPad> =>
  invoke("restore_pad", { id });

export const deleteTrash = (id: string): Promise<void> =>
  invoke("delete_trash", { id });

export const listRevisions = (id: string): Promise<number[]> =>
  invoke("list_revisions", { id });

export const readRevision = (id: string, ts: number): Promise<string> =>
  invoke("read_revision", { id, ts });

export const forceSnapshot = (id: string, content: string): Promise<void> =>
  invoke("force_snapshot", { id, content });

export const exportPad = (id: string, dest: string): Promise<void> =>
  invoke("export_pad", { id, dest });

export const importFile = (path: string): Promise<string> =>
  invoke("import_file", { path });

// ---- Synced-folder stop-gap: workspace location (#20) ----

export const getWorkspaceLocation = (): Promise<WorkspaceLocation> =>
  invoke("get_workspace_location");

/** Move the workspace to `newRoot` (copy → switch → cleanup; never loses data). */
export const setWorkspaceRoot = (
  newRoot: string,
): Promise<WorkspaceLocation> => invoke("set_workspace_root", { newRoot });

export const clearWorkspaceRoot = (): Promise<WorkspaceLocation> =>
  invoke("clear_workspace_root");

// ---- Window controls ----

export const hidePopover = (): Promise<void> => invoke("hide_popover");

export const setPinned = (pinned: boolean): Promise<void> =>
  invoke("set_pinned", { pinned });

/** Register a new global summon shortcut. Rejects on invalid/conflicting combo. */
export const setShortcut = (accelerator: string): Promise<void> =>
  invoke("set_shortcut", { accelerator });

export const quitApp = (): Promise<void> => invoke("quit_app");

/** How a pad's latest text is actually persisted. Injectable so the CRDT doc
 *  store (since #16) can fold each save into an Automerge change before writing
 *  both the `.automerge` binary and its `.md` mirror. Defaults to the plain
 *  `.md`-only path. */
export type PersistFn = (id: string, content: string) => Promise<void>;

/**
 * Invisible autosave engine.
 *
 * Coalesces rapid keystrokes into a single debounced write per pad, and can be
 * flushed synchronously (on blur / hide / quit) so nothing is ever lost. There
 * is intentionally NO "saving…" / "saved" surface — saving just always works.
 *
 * Durability model
 * ----------------
 * A failed save is retried *inline, inside the awaited in-flight promise* with
 * bounded backoff — never re-scheduled behind a fresh debounce timer. This is
 * the crux of the data-safety rule: `flushAll()` (called on blur/hide/quit)
 * must not resolve while *any* write is still owed, so the awaited promise has
 * to stay unresolved until the bytes are actually on disk (or every bounded
 * attempt is exhausted, in which case it rejects loudly rather than lying).
 *
 * Each retry re-reads the LATEST content for the pad from `pending` before
 * writing, so a retry can never clobber a newer edit with stale text, and the
 * single in-flight loop is the only writer for an id, which preserves per-pad
 * write ordering. `cancel()`/`idle()` tear down the retry loop (abort flag +
 * backoff timer) so nothing can resurrect a write after the saver was told to
 * stop.
 */
export class AutoSaver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, string>();
  /** Writes that have started (persist in progress) — awaitable via idle().
   *  Stays unresolved across retries until the bytes land (or attempts run out). */
  private inflight = new Map<string, Promise<void>>();
  /** Abort tokens for in-flight retry loops, keyed by id. Bumping the token (or
   *  deleting it) makes the running loop stop before its next attempt. */
  private aborters = new Map<string, { aborted: boolean }>();
  /** Pending backoff sleeps, so cancel()/idle() can wake them immediately. */
  private backoffs = new Map<string, () => void>();
  private delay: number;
  private persist: PersistFn;
  /** Max save attempts before surfacing a real rejection (1 try + N retries). */
  private maxAttempts: number;
  /** Base backoff between retry attempts; grows linearly per attempt. */
  private retryDelay: number;

  constructor(
    delayMs = 400,
    persist: PersistFn = savePadNow,
    maxAttempts = 5,
    retryDelayMs = 400,
  ) {
    this.delay = delayMs;
    this.persist = persist;
    this.maxAttempts = maxAttempts;
    this.retryDelay = retryDelayMs;
  }

  /** Queue a debounced save for a pad. */
  queue(id: string, content: string) {
    this.pending.set(id, content);
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => {
        void this.flushOne(id).catch((err) => {
          // Debounced path can't surface rejections to anyone; log only. The
          // pending edit (if newer) is still queued and will be retried.
          console.error("autosave failed after retries", err);
        });
      }, this.delay),
    );
  }

  /** Append `task` to a pad's serialized write chain so it never overlaps or
   *  races another write to the same `<id>.md`/`.automerge`. The returned promise
   *  resolves when `task` (after any prior write) has finished. */
  private chain(id: string, task: () => Promise<void>): Promise<void> {
    const prior = this.inflight.get(id);
    const run = (async () => {
      // Preserve write ordering: never start before the previous write finishes.
      if (prior) await prior.catch(() => {});
      await task();
    })();
    this.inflight.set(id, run);
    // Clean up on settle WITHOUT a bare `.finally(...)`: a rejected `run` would
    // make the derived `.finally` promise reject too, and discarding it (`void`)
    // leaks an unhandled rejection even though the caller handles `run` itself.
    // `then(cb, cb)` settles the cleanup promise on both paths (mirrors the
    // pattern in `flushOne`), so only the returned `run` carries the rejection.
    const cleanup = () => {
      if (this.inflight.get(id) === run) this.inflight.delete(id);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private flushOne(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    // Nothing queued — return any in-flight write so callers can await it.
    if (!this.pending.has(id))
      return this.inflight.get(id) ?? Promise.resolve();

    // If a write is already in flight, it already owns this id and will pick
    // up the newer `pending` value on its next attempt — just await it.
    const prior = this.inflight.get(id);
    if (prior) return prior;

    const aborter = { aborted: false };
    this.aborters.set(id, aborter);

    const run = (async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        if (aborter.aborted) return; // cancelled — drop silently
        // Always persist the LATEST queued content, never stale captured text.
        const content = this.pending.get(id);
        if (content === undefined) return; // nothing left to write
        try {
          // Use the injected persist fn (since #16 this folds the save into the
          // Automerge doc + writes both `.automerge` and the `.md` mirror) —
          // NOT savePadNow, which would bypass the CRDT store and only write .md.
          await this.persist(id, content);
        } catch (err) {
          lastErr = err;
          if (aborter.aborted) return;
          console.error("autosave retry", err);
          await this.sleep(id, this.retryDelay * (attempt + 1));
          continue;
        }
        // Success. Only clear the pending entry if it wasn't superseded by a
        // newer edit while the write was in flight; otherwise loop and write
        // the newer content (preserving ordering — we're the sole writer).
        if (this.pending.get(id) === content) {
          this.pending.delete(id);
          return;
        }
        attempt = -1; // newer content arrived: reset the attempt budget
      }
      // Exhausted every attempt: surface a real rejection rather than a false
      // success, so flushAll() callers (quit/hide) can see the failure.
      throw lastErr ?? new Error(`autosave failed for ${id}`);
    })();

    this.inflight.set(id, run);
    const cleanup = () => {
      if (this.inflight.get(id) === run) this.inflight.delete(id);
      if (this.aborters.get(id) === aborter) this.aborters.delete(id);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  /**
   * Run a one-off persist for a pad on the SAME per-id serialized chain the
   * debounced saves use, so a migration / seed write can't race a fast first
   * keystroke's write to the same `<id>` files. Stays invisible: failures throw
   * to the caller rather than surfacing any save indicator.
   */
  enqueue(id: string, task: () => Promise<void>): Promise<void> {
    return this.chain(id, task);
  }

  /** Interruptible sleep used between retry attempts. Resolves early (so the
   *  retry loop re-checks its abort flag and bails) when cancel()/idle() fire. */
  private sleep(id: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.backoffs.delete(id);
        resolve();
      }, ms);
      this.backoffs.set(id, () => {
        clearTimeout(timer);
        this.backoffs.delete(id);
        resolve();
      });
    });
  }

  /** Drop any QUEUED (not-yet-started) write for a pad AND stop an in-flight
   *  retry loop so a late retry can never resurrect/clobber after cancel. */
  cancel(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
    const aborter = this.aborters.get(id);
    if (aborter) aborter.aborted = true;
    this.backoffs.get(id)?.(); // wake a sleeping retry so it sees the abort
  }

  /** Resolve once any in-flight write for a pad has finished, so destructive
   *  ops (trash/restore) can't be overtaken by a late save recreating the file.
   *  Also wakes a backoff sleep so a retry loop can't outlive this await. */
  async idle(id: string): Promise<void> {
    const aborter = this.aborters.get(id);
    if (aborter) aborter.aborted = true;
    this.backoffs.get(id)?.();
    await this.inflight.get(id)?.catch(() => {});
  }

  /** Persist everything pending and await all in-flight writes. Loops until
   *  BOTH `pending` and `inflight` are drained, so it can never resolve while a
   *  retry is still owed (the data-safety guarantee for blur/hide/quit). */
  async flushAll(): Promise<void> {
    // Bounded so a permanently-failing write can't hang shutdown forever; once
    // a write exhausts its own retry budget it rejects and we surface that.
    for (let pass = 0; pass < this.maxAttempts + 1; pass++) {
      const ids = new Set<string>([
        ...this.pending.keys(),
        ...this.inflight.keys(),
      ]);
      if (ids.size === 0) return;
      await Promise.all([...ids].map((id) => this.flushOne(id)));
      if (this.pending.size === 0 && this.inflight.size === 0) return;
    }
  }
}
