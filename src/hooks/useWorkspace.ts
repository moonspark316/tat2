import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorName, Index, PadMeta, ThemeMode } from "../types";
import { nextColor } from "../palette";
import {
  AutoSaver,
  deletePad as deletePadOnDisk,
  loadWorkspace,
  saveIndex,
  savePadNow,
} from "../storage";

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
    const id = `pad-${now}`;
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
    (id: string) => {
      if (!index || index.pads.length <= 1) return;
      const remaining = index.pads.filter((p) => p.id !== id);
      const nextActive = activeId === id ? (remaining[0]?.id ?? null) : activeId;
      void deletePadOnDisk(id);
      setContents((c) => {
        const { [id]: _drop, ...rest } = c;
        return rest;
      });
      persistIndex({ ...index, pads: remaining, activePadId: nextActive });
    },
    [index, activeId, persistIndex],
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
    flush,
  };
}
