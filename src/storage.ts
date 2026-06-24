import { invoke } from "@tauri-apps/api/core";
import type { Index, Workspace } from "./types";

// ---- Thin wrappers over the Rust storage commands ----

export const loadWorkspace = (): Promise<Workspace> =>
  invoke("load_workspace");

export const saveIndex = (index: Index): Promise<void> =>
  invoke("save_index", { index });

export const savePadNow = (id: string, content: string): Promise<void> =>
  invoke("save_pad", { id, content });

export const deletePad = (id: string): Promise<void> =>
  invoke("delete_pad", { id });

export const listRevisions = (id: string): Promise<number[]> =>
  invoke("list_revisions", { id });

export const readRevision = (id: string, ts: number): Promise<string> =>
  invoke("read_revision", { id, ts });

export const forceSnapshot = (id: string, content: string): Promise<void> =>
  invoke("force_snapshot", { id, content });

// ---- Window controls ----

export const hidePopover = (): Promise<void> => invoke("hide_popover");

export const setPinned = (pinned: boolean): Promise<void> =>
  invoke("set_pinned", { pinned });

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

  private async flushOne(id: string) {
    const content = this.pending.get(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (content === undefined) return;
    this.pending.delete(id);
    try {
      await savePadNow(id, content);
    } catch (err) {
      // Never fail loudly: requeue and try again shortly.
      console.error("autosave retry", err);
      this.queue(id, content);
    }
  }

  /** Persist everything that is still pending, immediately. */
  async flushAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    await Promise.all(ids.map((id) => this.flushOne(id)));
  }
}
