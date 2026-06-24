import { invoke } from "@tauri-apps/api/core";
import type { Index, PadMeta, TrashEntry, RestoredPad, Workspace } from "./types";

// ---- Thin wrappers over the Rust storage commands ----

export const loadWorkspace = (): Promise<Workspace> =>
  invoke("load_workspace");

export const saveIndex = (index: Index): Promise<void> =>
  invoke("save_index", { index });

export const savePadNow = (id: string, content: string): Promise<void> =>
  invoke("save_pad", { id, content });

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

// ---- Window controls ----

export const hidePopover = (): Promise<void> => invoke("hide_popover");

export const setPinned = (pinned: boolean): Promise<void> =>
  invoke("set_pinned", { pinned });

/** Register a new global summon shortcut. Rejects on invalid/conflicting combo. */
export const setShortcut = (accelerator: string): Promise<void> =>
  invoke("set_shortcut", { accelerator });

export const quitApp = (): Promise<void> => invoke("quit_app");

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
  /** Writes that have started (savePadNow in progress) — awaitable via idle(). */
  private inflight = new Map<string, Promise<void>>();
  private delay: number;

  constructor(delayMs = 400) {
    this.delay = delayMs;
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
        await savePadNow(id, content);
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
