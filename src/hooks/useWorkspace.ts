import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorName, Index, PadMeta, ThemeMode } from "../types";
import { nextColor } from "../palette";
import {
  AutoSaver,
  forceSnapshot,
  loadWorkspace,
  restorePad,
  saveIndex,
  trashPad,
} from "../storage";
import { PadDocStore } from "../automerge/store";

/** Collision-proof pad id (timestamp + random suffix). */
function newPadId(): string {
  return `pad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Pure index transitions.
//
// These are deliberately pure (latest `Index` in -> next `Index` out) so the
// mutating callbacks below can apply them inside a *functional* `setIndex`
// updater, against whatever the LATEST index is at commit time — never a stale
// `index` captured before an `await`. That captured-then-written-back-stale
// pattern was the shared root cause of #59/#60/#61 (a concurrent edit/add/remove
// that landed during an await was silently dropped). Keeping them pure also
// makes the data-loss-relevant logic unit-testable without mounting React.
// ---------------------------------------------------------------------------

/** Append `pad` to the workspace and make it active, re-deriving `order` from
 *  the latest pad count so it lands at the end even if pads changed mid-await. */
export function appendActivePad(index: Index, pad: PadMeta): Index {
  const next: PadMeta = { ...pad, order: index.pads.length };
  return { ...index, pads: [...index.pads, next], activePadId: next.id };
}

/** Remove pad `id` from the workspace. If it was active, fall back to the first
 *  remaining pad; otherwise keep the latest active selection (which may have
 *  changed during an in-flight trash — the #60 stale-activeId fix). Returns the
 *  unchanged index when `id` isn't present so a double-remove is a no-op. */
export function removePadFromIndex(index: Index, id: string): Index {
  if (!index.pads.some((p) => p.id === id)) return index;
  const pads = index.pads.filter((p) => p.id !== id);
  const activePadId =
    index.activePadId === id ? (pads[0]?.id ?? null) : index.activePadId;
  return { ...index, pads, activePadId };
}

/** A pad is visible in the strip iff it isn't archived. Test with truthiness —
 *  Rust omits `archived` when false, so `=== false` would wrongly reject a pad
 *  whose key is simply absent (#68). */
export const isVisible = (p: PadMeta): boolean => !p.archived;

/**
 * Archive pad `id` (OneTab-style): flip `archived:true`. No-op (returns the
 * SAME reference) if the target is already archived, isn't present, or archiving
 * it would leave zero visible pads — the strip must never be empty. If the
 * archived pad was the active one, re-derive the active selection to the first
 * STILL-visible pad (mirroring `removePadFromIndex`'s fallback shape), since an
 * archived pad can no longer be the strip's active pad.
 */
export function archivePadFromIndex(index: Index, id: string): Index {
  const target = index.pads.find((p) => p.id === id);
  if (!target || target.archived) return index;
  // Never archive the last visible pad.
  if (index.pads.filter(isVisible).length <= 1) return index;
  const pads = index.pads.map((p) =>
    p.id === id ? { ...p, archived: true } : p,
  );
  const stillVisible = pads.filter(isVisible);
  const activePadId =
    index.activePadId === id
      ? (stillVisible[0]?.id ?? null)
      : index.activePadId;
  return { ...index, pads, activePadId };
}

/** Unarchive pad `id`: clear `archived`. No active-pad change. No-op (same
 *  reference) if the pad isn't present or isn't archived. */
export function unarchivePadFromIndex(index: Index, id: string): Index {
  const target = index.pads.find((p) => p.id === id);
  if (!target || !target.archived) return index;
  const pads = index.pads.map((p) =>
    p.id === id ? { ...p, archived: false } : p,
  );
  return { ...index, pads };
}

/**
 * Archive many pads at once (right-click bulk actions: "archive to the left /
 * right / others / all"). Archives every currently-visible pad whose id is in
 * `ids`; already-archived ids and unknown ids are ignored. Upholds the same
 * invariant as `archivePadFromIndex`: the strip is never emptied — if `ids`
 * would archive every visible pad, one is spared (the active pad when it's in
 * the set, otherwise the last visible pad in strip order). If the active pad
 * ends up archived, the active selection falls back to the first still-visible
 * pad. Returns the SAME reference when nothing changes.
 */
export function archiveManyFromIndex(index: Index, ids: string[]): Index {
  const idSet = new Set(ids);
  const visible = index.pads.filter(isVisible);
  let toArchive = visible.filter((p) => idSet.has(p.id));
  if (toArchive.length === 0) return index;
  // Never empty the strip: if this covers every visible pad, spare one.
  if (toArchive.length >= visible.length) {
    const active = index.activePadId;
    const spareId =
      active && idSet.has(active) ? active : visible[visible.length - 1].id;
    toArchive = toArchive.filter((p) => p.id !== spareId);
  }
  if (toArchive.length === 0) return index;
  const archiveSet = new Set(toArchive.map((p) => p.id));
  const pads = index.pads.map((p) =>
    archiveSet.has(p.id) ? { ...p, archived: true } : p,
  );
  const stillVisible = pads.filter(isVisible);
  const activePadId =
    index.activePadId && archiveSet.has(index.activePadId)
      ? (stillVisible[0]?.id ?? null)
      : index.activePadId;
  return { ...index, pads, activePadId };
}

/** Unarchive every archived pad in one shot (right-click "unarchive all").
 *  Returns the SAME reference if nothing is archived. */
export function unarchiveAllFromIndex(index: Index): Index {
  if (!index.pads.some((p) => p.archived)) return index;
  const pads = index.pads.map((p) =>
    p.archived ? { ...p, archived: false } : p,
  );
  return { ...index, pads };
}

/**
 * Merge a strip reorder (visible-only `orderedIds`, in their new order) back
 * into the FULL pad list, leaving archived pads pinned at their current slots.
 *
 * The strip only ever shows/drag-reorders visible pads, so `orderedIds` is a
 * permutation of the visible ids ONLY. We walk the current full list in place:
 * each visible slot consumes the next id from `orderedIds` (looked up by id);
 * archived slots keep whatever pad already sits there. Then `order` is assigned
 * in a single sequential pass over the resulting full array so there are no
 * gaps or collisions and archived pads survive the reorder (#68).
 */
export function reorderVisibleInIndex(
  index: Index,
  orderedIds: string[],
): Index {
  const byId = new Map(index.pads.map((p) => [p.id, p]));
  let cursor = 0;
  const merged: PadMeta[] = index.pads.map((p) => {
    if (!isVisible(p)) return p; // archived pad stays pinned in place
    // Consume the next visible id from the reordered list.
    while (cursor < orderedIds.length && !byId.has(orderedIds[cursor])) cursor++;
    const nextId = orderedIds[cursor++];
    return byId.get(nextId) ?? p;
  });
  const pads = merged.map((p, order) => (p.order === order ? p : { ...p, order }));
  return { ...index, pads };
}

/** Ensure at least one pad is visible: if EVERY pad is archived, unarchive the
 *  active pad (or the first pad) so the strip is never empty and there is always
 *  an editable active pad. Returns the SAME reference when nothing needs fixing
 *  so callers can skip a redundant persist. */
export function ensureVisiblePad(index: Index): Index {
  if (index.pads.length === 0 || index.pads.some(isVisible)) return index;
  const reviveId = index.activePadId ?? index.pads[0].id;
  const pads = index.pads.map((p) =>
    p.id === reviveId ? { ...p, archived: false } : p,
  );
  const activePadId = index.activePadId ?? pads[0].id;
  return { ...index, pads, activePadId };
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
      // Load-time invariant (#68): the strip must never be empty. If every pad
      // loaded archived (e.g. a hand-edited index.json), revive the active/first
      // pad so there is always a visible, editable active pad — and persist the
      // normalized index so the fix is durable.
      const normalized = ensureVisiblePad(ws.index);
      if (normalized !== ws.index) void saveIndex(normalized);
      setIndex(normalized);
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

  /**
   * Apply a pure transition against the LATEST index and persist the result.
   *
   * Unlike `persistIndex(next)` — which writes back a concrete index value the
   * caller computed earlier — this re-snapshots inside the `setIndex` updater,
   * so a transition issued after an `await` never clobbers edits/adds/removes
   * that landed during that await (#59/#60/#61). The transition must be pure;
   * the single persist side-effect runs once on the value actually committed.
   */
  const persistIndexUpdate = useCallback(
    (transition: (prev: Index) => Index) => {
      setIndex((prev) => {
        if (!prev) return prev;
        const next = transition(prev);
        if (next !== prev) void saveIndex(next);
        return next;
      });
    },
    [],
  );

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
      if (!index) return;
      // Cycle only through VISIBLE pads — archived ones aren't in the strip
      // (#68). If the active pad isn't visible, step in from the edge.
      const visible = index.pads.filter(isVisible);
      if (visible.length === 0) return;
      const i = visible.findIndex((p) => p.id === activeId);
      const next =
        i === -1
          ? delta > 0
            ? visible[0]
            : visible[visible.length - 1]
          : visible[(i + delta + visible.length) % visible.length];
      if (next) switchPad(next.id);
    },
    [index, activeId, switchPad],
  );

  const switchByPosition = useCallback(
    (pos: number) => {
      if (!index) return;
      // Index into the VISIBLE subset so ⌘1..⌘9 map to the strip the user sees.
      // Keep the `if (pad)` guard so e.g. ⌘7 with 3 visible pads is a no-op.
      const pad = index.pads.filter(isVisible)[pos];
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
    // Route the initial content write through the AutoSaver's per-id serialized
    // chain (#58) instead of a fire-and-forget `savePadDocNow`: it is then
    // strictly ordered before any first-keystroke save to the same `<id>` files
    // (so the two can't race on the temp files), and its promise surfaces a
    // failure to the caller's `.catch` rather than being silently swallowed.
    void saver.current
      .enqueue(id, () => store.current.persistFn(id, ""))
      .catch((err) => console.error("addPad persist", err));
    persistIndexUpdate((prev) => appendActivePad(prev, pad));
  }, [index, persistIndexUpdate]);

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
        // (both files) is complete, then move it to trash. Read the freshest
        // content from the store (not a `contents` snapshot captured before the
        // awaits) so an edit that landed mid-trash is included in the copy.
        await store.current.persistFn(id, store.current.text(id));
        await trashPad(meta); // soft-delete: recoverable from Trash
      } catch (err) {
        console.error("trash failed; keeping pad", err);
        return;
      }
      store.current.forget(id);
      setContents((c) => {
        const { [id]: _drop, ...rest } = c;
        return rest;
      });
      // Re-snapshot the LATEST index inside the updater: if the user switched
      // pads or added/removed another pad during the awaits above, removing this
      // one must not write back a stale index (dropping those changes) nor a
      // stale active selection (#60/#61). `removePadFromIndex` re-derives the
      // active pad from whatever is current.
      persistIndexUpdate((prev) => removePadFromIndex(prev, id));
    },
    [index, persistIndexUpdate],
  );

  /** Archive a pad (OneTab-style hide). Archived pads keep their CRDT doc
   *  resident for search/unarchive — we do NOT `store.forget()` here (only
   *  `removePad` forgets). */
  const archivePad = useCallback(
    async (id: string) => {
      // Archiving can change `activePadId`, so flush pending debounced edits
      // first (mirroring `switchPad`) — otherwise the 400ms in-flight keystrokes
      // to the pad being archived could be lost when the active pad moves.
      await saver.current.flushAll();
      persistIndexUpdate((prev) => archivePadFromIndex(prev, id));
    },
    [persistIndexUpdate],
  );

  /** Unarchive a pad, returning it to the strip. */
  const unarchivePad = useCallback(
    (id: string) => {
      persistIndexUpdate((prev) => unarchivePadFromIndex(prev, id));
    },
    [persistIndexUpdate],
  );

  /** Bulk-archive (right-click strip actions). Flush first for the same reason
   *  as `archivePad`: any of the archived pads may be the active one, and
   *  archiving moves the active selection — pending keystrokes must land first. */
  const archiveMany = useCallback(
    async (ids: string[]) => {
      await saver.current.flushAll();
      persistIndexUpdate((prev) => archiveManyFromIndex(prev, ids));
    },
    [persistIndexUpdate],
  );

  /** Return every archived pad to the strip in one shot. */
  const unarchiveAll = useCallback(() => {
    persistIndexUpdate((prev) => unarchiveAllFromIndex(prev));
  }, [persistIndexUpdate]);

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
      setContents((c) => ({ ...c, [id]: content }));
      // Append against the LATEST index inside the updater, never the `index`
      // captured before the `await restorePad` above: pads created or removed
      // while the restore was in flight would otherwise be dropped, and the
      // restored pad's `order` would be stale (#59/#61). Guard again here in
      // case the same id was concurrently re-added.
      // Clear `archived` so a restored pad is always visible in the strip
      // (never restored straight into the hidden archive) (#68).
      persistIndexUpdate((prev) =>
        prev.pads.some((p) => p.id === id)
          ? prev
          : appendActivePad(prev, { ...meta, archived: false }),
      );
    },
    [index, persistIndexUpdate],
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
    // `orderedIds` is the strip's VISIBLE pads in their new order. Merge it into
    // the full list so archived pads stay pinned and aren't dropped (#68).
    (orderedIds: string[]) => {
      persistIndexUpdate((prev) => reorderVisibleInIndex(prev, orderedIds));
    },
    [persistIndexUpdate],
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
      // Serialized initial write (#58): enqueue on the per-id chain so the
      // imported content's `.automerge`/`.md` is ordered before any first edit
      // and its failure surfaces to `.catch` — never a fire-and-forget
      // `savePadDocNow` that could race the first keystroke or swallow an error.
      void saver.current
        .enqueue(id, () => store.current.persistFn(id, store.current.text(id)))
        .catch((err) => console.error("importPad persist", err));
      persistIndexUpdate((prev) => appendActivePad(prev, pad));
    },
    [index, persistIndexUpdate],
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
    archivePad,
    unarchivePad,
    archiveMany,
    unarchiveAll,
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
