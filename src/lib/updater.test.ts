import { describe, expect, it, vi } from "vitest";

// The module imports the real Tauri plugins at top level; stub them so importing
// updater.ts doesn't blow up outside a Tauri runtime. The orchestration under
// test takes injected deps, so these stubs are never actually called.
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { applyUpdate, fetchUpdateQuietly, type UpdaterDeps } from "./updater";

function fakeUpdate(version: string) {
  return {
    version,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
}

describe("fetchUpdateQuietly", () => {
  it("returns null and installs nothing when up to date", async () => {
    const deps: UpdaterDeps = {
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn(),
    };
    const onDownloading = vi.fn();
    const onReady = vi.fn();

    const result = await fetchUpdateQuietly(deps, { onDownloading, onReady });

    expect(result).toBeNull();
    expect(onDownloading).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("downloads + verifies and reports the staged version when an update exists", async () => {
    const update = fakeUpdate("1.2.0");
    const deps: UpdaterDeps = {
      // The plugin's Update type is richer than our stub; the orchestration only
      // touches `.version` and `.downloadAndInstall()`.
      check: vi.fn().mockResolvedValue(update as never),
      relaunch: vi.fn(),
    };
    const order: string[] = [];

    const result = await fetchUpdateQuietly(deps, {
      onDownloading: (v) => order.push(`downloading:${v}`),
      onReady: (v) => order.push(`ready:${v}`),
    });

    expect(result).toBe("1.2.0");
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    // Download is signalled BEFORE install completes, ready AFTER.
    expect(order).toEqual(["downloading:1.2.0", "ready:1.2.0"]);
  });

  it("propagates a download/verification failure (caller swallows on the silent path)", async () => {
    const update = {
      version: "1.2.0",
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("bad signature")),
    };
    const deps: UpdaterDeps = {
      check: vi.fn().mockResolvedValue(update as never),
      relaunch: vi.fn(),
    };

    await expect(fetchUpdateQuietly(deps)).rejects.toThrow("bad signature");
  });

  it("propagates a check (network) failure", async () => {
    const deps: UpdaterDeps = {
      check: vi.fn().mockRejectedValue(new Error("offline")),
      relaunch: vi.fn(),
    };
    await expect(fetchUpdateQuietly(deps)).rejects.toThrow("offline");
  });
});

describe("applyUpdate", () => {
  it("delegates to relaunch", async () => {
    const relaunch = vi.fn().mockResolvedValue(undefined);
    await applyUpdate({ check: vi.fn(), relaunch });
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
