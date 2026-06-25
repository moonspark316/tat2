import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorName, Index, PadMeta, ThemeMode } from "../types";
import { nextColor } from "../palette";
import {
  AutoSaver,
  forceSnapshot,
  loadWorkspace,
  restorePad,
  saveIndex,
  savePadDocNow,
  trashPad,
} from "../storage";
import { PadDocStore } from "../automerge/store";

/** Collision-proof pad id (timestamp + random suffix). */
function newPadId(): string {
  return `pad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Owns all workspace state (pads, contents, active selection, settings) and the
 * invisible autosave engine. UI components stay presentational.
 */
export function useWorkspace() {
  const [index, setIndex] = useState<Index | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  // The CRDT doc store owns each pad's Automerge document; the autosaver folds
  // every save into a change and persists the binary + `.md` mirror via it.
  const store = useRef(new PadDocStore());
  const saver = useRef(new AutoSaver(400, store.current.persistFn));
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadWorkspace().then((ws) => {
      // Hydrate the CRDT docs (loading existing `.automerge` binaries, seeding
      // fresh docs from `.md` for pads that predate the migration).
      const migrated = store.current.hydrate(ws);
      setIndex(ws.index);
      // Use the docs' canonical text so the editor and CRDT never diverge.
      const text: Record<string, string> = {};
      for (const pad of ws.index.pads) {
        text[pad.id] = store.current.has(pad.id)
          ? store.current.text(pad.id)
          : (ws.contents[pad.id] ?? "");
      }
      setContents(text);
      // Make the migration durable: persist each freshly-seeded/healed pad's
      // binary once. Route it through the AutoSaver's per-id serialized chain
      // (not a bare `savePadDocNow`) so a very fast first keystroke's write to
      // the same `<id>.md`/`.automerge` is strictly ordered after the migration
      // write and can't race it on the temp files. The `.md` is rewritten with
      // identical text (atomic, lossless); persistence stays invisible.
      for (const id of migrated) {
        void saver.current
          .enqueue(id, () => store.current.persistFn(id, store.current.text(id)))
          // Never fail loudly: the `.md` source of truth is already on disk, so
          // a failed binary re-persist just retries on the next edit/launch.
          .catch((err) => console.error("migration persist", err));
      }
    });
  }, []);

  const activeId = index?.activePadId ?? null;
  const activePad: PadMeta | null = useMemo(
    () => index?.pads.find((p) => p.id === activeId) ?? null,
    [index, activeId],
  );
  const activeContent = activeId ? (contents[activeId] ?? "") : "";

  const persistIndex = useCallback((next: Index) => {
    setIndex(next);
    void saveIndex(next);
  }, []);

  const edit = useCallback(
    (value: string) => {
      if (!activeId) return;
      setContents((c) => ({ ...c, [activeId]: value }));
      saver.current.queue(activeId, value);
      const now = Date.now();
      setIndex((idx) =>
        idx
          ? {
              ...idx,
              pads: idx.pads.map((p) =>
                p.id === activeId ? { ...p, updatedAt: now } : p,
              ),
            }
          : idx,
      );
    },
    [activeId],
  );

  const switchPad = useCallback(
    (id: string) => {
      if (!index || id === activeId) return;
      void saver.current.flushAll();
      persistIndex({ ...index, activePadId: id });
    },
    [index, activeId, persistIndex],
  );

  const switchByOffset = useCallback(
    (delta: number) => {
      if (!index || index.pads.length === 0) return;
      const i = index.pads.findIndex((p) => p.id === activeId);
      const next =
        index.pads[(i + delta + index.pads.length) % index.pads.length];
      if (next) switchPad(next.id);
    },
    [index, activeId, switchPad],
  );

  const switchByPosition = useCallback(
    (pos: number) => {
      if (!index) return;
      const pad = index.pads[pos];
      if (pad) switchPad(pad.id);
    },
    [index, switchPad],
  );

  const addPad = useCallback(() => {
    if (!index) return;
    const used = index.pads.map((p) => p.color);
    const now = Date.now();
    const id = newPadId();
    const pad: PadMeta = {
      id,
      title: "Sketchpad",
      color: nextColor(used),
      order: index.pads.length,
      createdAt: now,
      updatedAt: now,
    };
    setContents((c) => ({ ...c, [id]: "" }));
    store.current.ensure(id, "");
    const bytes = store.current.bytes(id);
    if (bytes) void savePadDocNow(id, bytes, "");
    persistIndex({ ...index, pads: [...index.pads, pad], activePadId: id });
  }, [index, persistIndex]);

  const removePad = useCallback(
    async (id: string) => {
      if (!index || index.pads.length <= 1) return;
      const meta = index.pads.find((p) => p.id === id);
      if (!meta) return;
      // Persist the latest edits first so the trashed copy is complete, then
      // move to trash. Only drop the pad from the index once trashing succeeds,
      // so a failed move never makes the pad silently vanish.
      saver.current.cancel(id);
      await saver.current.idle(id); // let any in-flight save finish first
      try {
        // Persist the latest content into the CRDT + `.md` so the trashed copy
        // (both files) is complete, then move it to trash.
        await store.current.persistFn(id, contents[id] ?? "");
        await trashPad(meta); // soft-delete: recoverable from Trash
      } catch (err) {
        console.error("trash failed; keeping pad", err);
        return;
      }
      store.current.forget(id);
      const remaining = index.pads.filter((p) => p.id !== id);
      const nextActive = activeId === id ? (remaining[0]?.id ?? null) : activeId;
      setContents((c) => {
        const { [id]: _drop, ...rest } = c;
        return rest;
      });
      persistIndex({ ...index, pads: remaining, activePadId: nextActive });
    },
    [index, activeId, contents, persistIndex],
  );

  /** Bring a trashed pad back into the workspace. */
  const restoreFromTrash = useCallback(
    async (id: string) => {
      if (!index) return;
      if (index.pads.some((p) => p.id === id)) return;
      const { meta, content, doc } = await restorePad(id);
      // Re-adopt the pad's CRDT: prefer its restored binary (full history),
      // else seed a fresh doc from the recovered `.md` text.
      if (doc && doc.length > 0) store.current.adoptBytes(id, doc);
      else store.current.ensure(id, content);
      const restored: PadMeta = { ...meta, order: index.pads.length };
      setContents((c) => ({ ...c, [id]: content }));
      persistIndex({
        ...index,
        pads: [...index.pads, restored],
        activePadId: id,
      });
    },
    [index, persistIndex],
  );

  const renamePad = useCallback(
    (id: string, title: string) => {
      if (!index) return;
      persistIndex({
        ...index,
        pads: index.pads.map((p) => (p.id === id ? { ...p, title } : p)),
      });
    },
    [index, persistIndex],
  );

  const recolorPad = useCallback(
    (id: string, color: ColorName) => {
      if (!index) return;
      persistIndex({
        ...index,
        pads: index.pads.map((p) => (p.id === id ? { ...p, color } : p)),
      });
    },
    [index, persistIndex],
  );

  const reorderPads = useCallback(
    (orderedIds: string[]) => {
      if (!index) return;
      const byId = new Map(index.pads.map((p) => [p.id, p]));
      const pads = orderedIds
        .map((id, order) => {
          const p = byId.get(id);
          return p ? { ...p, order } : null;
        })
        .filter((p): p is PadMeta => p !== null);
      persistIndex({ ...index, pads });
    },
    [index, persistIndex],
  );

  const setFontSize = useCallback(
    (size: number) => {
      if (!index) return;
      persistIndex({
        ...index,
        settings: {
          ...index.settings,
          fontSize: Math.min(28, Math.max(11, size)),
        },
      });
    },
    [index, persistIndex],
  );

  /** Create a pad pre-filled with imported content. */
  const importPad = useCallback(
    (title: string, content: string) => {
      if (!index) return;
      const used = index.pads.map((p) => p.color);
      const now = Date.now();
      const id = newPadId();
      const pad: PadMeta = {
        id,
        title: title || "Sketchpad",
        color: nextColor(used),
        order: index.pads.length,
        createdAt: now,
        updatedAt: now,
      };
      setContents((c) => ({ ...c, [id]: content }));
      store.current.ensure(id, content);
      const bytes = store.current.bytes(id);
      if (bytes) void savePadDocNow(id, bytes, store.current.text(id));
      persistIndex({ ...index, pads: [...index.pads, pad], activePadId: id });
    },
    [index, persistIndex],
  );

  /** Replace the active pad's content (e.g. restoring a revision), snapshotting
   *  the current content first so the restore itself is reversible. */
  const restoreContent = useCallback(
    async (content: string) => {
      if (!activeId) return;
      // Drop the queued save and wait out any in-flight one so neither can
      // overwrite the restored content.
      saver.current.cancel(activeId);
      await saver.current.idle(activeId);
      const current = contents[activeId] ?? "";
      if (current.length > 0) await forceSnapshot(activeId, current);
      setContents((c) => ({ ...c, [activeId]: content }));
      // Apply the restore as a CRDT change so history + sync stay coherent.
      await store.current.persistFn(activeId, content);
    },
    [activeId, contents],
  );

  const setTheme = useCallback(
    (theme: ThemeMode) => {
      if (!index) return;
      persistIndex({ ...index, settings: { ...index.settings, theme } });
    },
    [index, persistIndex],
  );

  const setGlobalShortcut = useCallback(
    (globalShortcut: string) => {
      if (!index) return;
      persistIndex({
        ...index,
        settings: { ...index.settings, globalShortcut },
      });
    },
    [index, persistIndex],
  );

  const flush = useCallback(() => saver.current.flushAll(), []);

  return {
    ready: index !== null,
    index,
    contents,
    activeId,
    activePad,
    activeContent,
    saver,
    edit,
    switchPad,
    switchByOffset,
    switchByPosition,
    addPad,
    removePad,
    renamePad,
    recolorPad,
    reorderPads,
    setFontSize,
    setTheme,
    setGlobalShortcut,
    importPad,
    restoreContent,
    restoreFromTrash,
    flush,
  };
}
