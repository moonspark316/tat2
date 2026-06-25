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
 */
export class AutoSaver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, string>();
  /** Writes that have started (persist in progress) — awaitable via idle(). */
  private inflight = new Map<string, Promise<void>>();
  private delay: number;
  private persist: PersistFn;

  constructor(delayMs = 400, persist: PersistFn = savePadNow) {
    this.delay = delayMs;
    this.persist = persist;
  }

  /** Queue a debounced save for a pad. */
  queue(id: string, content: string) {
    this.pending.set(id, content);
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => {
        void this.flushOne(id);
      }, this.delay),
    );
  }

  private flushOne(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const content = this.pending.get(id);
    // Nothing queued — return any in-flight write so callers can await it.
    if (content === undefined) return this.inflight.get(id) ?? Promise.resolve();
    this.pending.delete(id);

    const prior = this.inflight.get(id);
    const run = (async () => {
      // Preserve write ordering: never start before the previous write finishes.
      if (prior) await prior.catch(() => {});
      try {
        await this.persist(id, content);
      } catch (err) {
        // Never fail loudly: requeue and try again shortly.
        console.error("autosave retry", err);
        this.queue(id, content);
      }
    })();
    this.inflight.set(id, run);
    void run.finally(() => {
      if (this.inflight.get(id) === run) this.inflight.delete(id);
    });
    return run;
  }

  /** Drop any QUEUED (not-yet-started) write for a pad. Does not abort an
   *  in-flight write — use idle(id) to await that. */
  cancel(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
  }

  /** Resolve once any in-flight write for a pad has finished, so destructive
   *  ops (trash/restore) can't be overtaken by a late save recreating the file. */
  async idle(id: string): Promise<void> {
    await this.inflight.get(id)?.catch(() => {});
  }

  /** Persist everything pending and await all in-flight writes. */
  async flushAll(): Promise<void> {
    const ids = new Set<string>([
      ...this.pending.keys(),
      ...this.inflight.keys(),
    ]);
    await Promise.all([...ids].map((id) => this.flushOne(id)));
  }
}
