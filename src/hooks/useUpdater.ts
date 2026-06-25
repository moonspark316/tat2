import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateState, UpdateStatus } from "../types";
import {
  applyUpdate,
  fetchUpdateQuietly,
  realDeps,
  type UpdaterDeps,
} from "../lib/updater";

/**
 * Drives the quiet auto-update lifecycle.
 *
 * On mount it runs ONE silent background check: if a newer signed build exists
 * it downloads it and flips `status` to "ready" so the UI can show a tiny
 * restart pill. A failed silent check is swallowed (never surfaced) — the app
 * must never nag about update plumbing.
 *
 * `check()` is the manual path (wired to a Settings button): it's allowed to
 * show the transient "checking" and "none" (up-to-date) states because the user
 * explicitly asked.
 */
export function useUpdater(deps: UpdaterDeps = realDeps) {
  const [state, setState] = useState<UpdateState>({
    status: "idle",
    version: null,
  });
  // A check/download is already in flight — don't start a second one (the launch
  // check and a quick manual click could otherwise race).
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = useCallback((status: UpdateStatus, version: string | null) => {
    if (mounted.current) setState({ status, version });
  }, []);

  const run = useCallback(
    async (manual: boolean) => {
      // Already ready-to-restart: re-checking can't improve on that.
      if (busy.current || state.status === "ready") return;
      busy.current = true;
      if (manual) set("checking", null);
      try {
        const version = await fetchUpdateQuietly(deps, {
          onDownloading: (v) => set("downloading", v),
          onReady: (v) => set("ready", v),
        });
        if (!version) {
          // Up to date. Only the manual path says so; the silent path goes quiet.
          set(manual ? "none" : "idle", null);
        }
      } catch (err) {
        // A failed background check must never surface. Manual checks get a
        // muted error state so the button can stop saying "Checking…".
        console.error("update check failed", err);
        if (manual) set("error", null);
        else set("idle", null);
      } finally {
        busy.current = false;
      }
    },
    [deps, set, state.status],
  );

  // One silent check shortly after launch. Deferred so it never competes with
  // first paint / workspace load.
  useEffect(() => {
    const t = setTimeout(() => void run(false), 1500);
    return () => clearTimeout(t);
    // run is stable enough for a launch-once check; deps are constant in prod.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = useCallback(() => run(true), [run]);
  const restart = useCallback(() => applyUpdate(deps), [deps]);
  const dismiss = useCallback(() => set("idle", null), [set]);

  return { state, check, restart, dismiss };
}
