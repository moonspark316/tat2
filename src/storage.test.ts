import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { AutoSaver } from "./storage";

describe("AutoSaver", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid edits into a single save with the latest content", async () => {
    const s = new AutoSaver(100);
    s.queue("a", "v1");
    s.queue("a", "v2");
    s.queue("a", "v3");
    await vi.advanceTimersByTimeAsync(150);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("save_pad", {
      id: "a",
      content: "v3",
    });
  });

  it("keeps separate pads independent", async () => {
    const s = new AutoSaver(100);
    s.queue("a", "A");
    s.queue("b", "B");
    await vi.advanceTimersByTimeAsync(150);
    expect(invokeMock).toHaveBeenCalledWith("save_pad", { id: "a", content: "A" });
    expect(invokeMock).toHaveBeenCalledWith("save_pad", { id: "b", content: "B" });
  });

  it("flushAll persists pending writes immediately", async () => {
    const s = new AutoSaver(10_000);
    s.queue("a", "x");
    await s.flushAll();
    expect(invokeMock).toHaveBeenCalledWith("save_pad", { id: "a", content: "x" });
  });

  it("cancel drops a queued (not-yet-started) save", async () => {
    const s = new AutoSaver(100);
    s.queue("a", "x");
    s.cancel("a");
    await vi.advanceTimersByTimeAsync(200);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("idle resolves after an in-flight save completes", async () => {
    let release!: () => void;
    invokeMock.mockReturnValueOnce(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const s = new AutoSaver(0);
    s.queue("a", "x");
    await vi.advanceTimersByTimeAsync(1); // fire timer -> save starts, stays pending

    let done = false;
    const idled = s.idle("a").then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false); // still in flight
    release();
    await idled;
    expect(done).toBe(true);
  });
});
