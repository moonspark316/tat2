import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { AutoSaver, savePadNow } from "./storage";

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

  it("enqueue serializes a one-off write with a fast keystroke's write to the same pad", async () => {
    // Mirrors the launch-migration race: a migration write (enqueue) and a very
    // fast first keystroke (queue) for the same pad must not interleave — the
    // keystroke's write must run strictly after the migration's.
    const order: string[] = [];
    let releaseMigration!: () => void;
    invokeMock.mockImplementation(
      (_cmd: string, args: { content?: string }) =>
        new Promise<void>((resolve) => {
          order.push(`start:${args.content}`);
          if (args.content === "migrated") {
            // Hold the migration write open so the keystroke can't sneak ahead.
            releaseMigration = () => {
              order.push("end:migrated");
              resolve();
            };
          } else {
            order.push(`end:${args.content}`);
            resolve();
          }
        }),
    );

    const s = new AutoSaver(0);
    // Migration write lands first on the chain. The real caller passes a thunk
    // (store.persistFn); here we drive the same `save_pad` invoke directly.
    const migration = s.enqueue("a", () => savePadNow("a", "migrated"));
    // A fast keystroke queues a write for the same pad before migration finishes.
    s.queue("a", "keystroke");
    await vi.advanceTimersByTimeAsync(1); // fire the keystroke timer

    // Keystroke write must not have started while migration is still in flight.
    expect(order).toEqual(["start:migrated"]);
    releaseMigration();
    await migration;
    await s.flushAll();

    // Strict ordering: migration fully completes before the keystroke write runs.
    expect(order).toEqual([
      "start:migrated",
      "end:migrated",
      "start:keystroke",
      "end:keystroke",
    ]);
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
