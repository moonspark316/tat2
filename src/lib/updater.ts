import type { Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Auto-update orchestration, kept deliberately quiet.
 *
 * The product rule is that Tat2 never nags. So the launch path here checks for
 * an update, downloads + verifies it silently in the background, and only ever
 * surfaces a single terminal state — a tiny, dismissible "restart to update"
 * affordance. There is no spinner, no "checking…" toast, and no version-behind
 * badge. A *manual* "Check for updates" (from Settings) is the one place we let
 * the transient checking / up-to-date states show, because the user explicitly
 * asked and expects feedback.
 *
 * The real Tauri calls are injected so the orchestration is unit-testable
 * without a running app (see updater.test.ts). Production callers use the
 * default `realDeps`.
 */

export interface UpdaterDeps {
  /** Resolve to the pending Update, or null if already up to date. */
  check: () => Promise<Update | null>;
  /** Restart the app to swap in the downloaded update. */
  relaunch: () => Promise<void>;
}

export const realDeps: UpdaterDeps = {
  // The plugin's check() returns `Update | null`.
  check: () => check(),
  relaunch: () => relaunch(),
};

export interface UpdateFoundCallbacks {
  /** A newer version exists and download has begun. */
  onDownloading?: (version: string) => void;
  /** Download finished + signature verified; safe to restart. */
  onReady?: (version: string) => void;
}

/**
 * Find, download, and verify an update without any user-facing noise.
 *
 * Returns the available version string if one was downloaded + verified (so the
 * caller can show the restart affordance), or null if already up to date.
 * Throws on transport/verification failure — callers on the silent launch path
 * should swallow that (a failed background check must never surface an error).
 */
export async function fetchUpdateQuietly(
  deps: UpdaterDeps,
  cb: UpdateFoundCallbacks = {},
): Promise<string | null> {
  const update = await deps.check();
  if (!update) return null;

  const version = update.version;
  cb.onDownloading?.(version);
  // downloadAndInstall stages the verified bundle; on macOS/Windows it's applied
  // on the next relaunch, so nothing is swapped under the user mid-session.
  await update.downloadAndInstall();
  cb.onReady?.(version);
  return version;
}

/** Restart into the freshly-downloaded build. */
export function applyUpdate(deps: UpdaterDeps): Promise<void> {
  return deps.relaunch();
}
