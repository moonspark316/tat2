import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorName, Index, PadMeta, ThemeMode } from "../types";
import { nextColor } from "../palette";
import {
  AutoSaver,
  forceSnapshot,
  loadWorkspace,
  restorePad,
  saveIndex,
  savePadNow,
  trashPad,
} from "../storage";

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
  const saver = useRef(new AutoSaver(400));
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadWorkspace().then((ws) => {
      setIndex(ws.index);
      setContents(ws.contents);
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
    void savePadNow(id, "");
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
      try {
        await savePadNow(id, contents[id] ?? "");
        await trashPad(meta); // soft-delete: recoverable from Trash
      } catch (err) {
        console.error("trash failed; keeping pad", err);
        return;
      }
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
      const { meta, content } = await restorePad(id);
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
      void savePadNow(id, content);
      persistIndex({ ...index, pads: [...index.pads, pad], activePadId: id });
    },
    [index, persistIndex],
  );

  /** Replace the active pad's content (e.g. restoring a revision), snapshotting
   *  the current content first so the restore itself is reversible. */
  const restoreContent = useCallback(
    async (content: string) => {
      if (!activeId) return;
      // Drop any pending debounced save so it can't overwrite the restore.
      saver.current.cancel(activeId);
      const current = contents[activeId] ?? "";
      if (current.length > 0) await forceSnapshot(activeId, current);
      setContents((c) => ({ ...c, [activeId]: content }));
      await savePadNow(activeId, content);
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
    importPad,
    restoreContent,
    restoreFromTrash,
    flush,
  };
}
