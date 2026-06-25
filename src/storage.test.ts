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

  // ---- Data-loss cluster regressions (#49, #52, #53, #22) ----

  it("flushAll does not resolve until a failed write is actually persisted (#49/#22)", async () => {
    // First save attempt rejects; the retry must succeed, and flushAll must
    // stay unresolved until that retry lands on disk.
    invokeMock.mockRejectedValueOnce(new Error("ENOSPC"));
    invokeMock.mockResolvedValue(undefined);

    const s = new AutoSaver(100, undefined, 5, 400);
    s.queue("a", "last-edit");

    let flushed = false;
    const flushing = s.flushAll().then(() => {
      flushed = true;
    });

    // Let the debounce fire and the first (failing) attempt run.
    await vi.advanceTimersByTimeAsync(150);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(false); // still owed — must NOT have falsely resolved

    // Advance through the backoff so the retry can run.
    await vi.advanceTimersByTimeAsync(450);
    await flushing;

    expect(flushed).toBe(true);
    // The content that was queued before flush is what ultimately persisted.
    expect(invokeMock).toHaveBeenLastCalledWith("save_pad", {
      id: "a",
      content: "last-edit",
    });
  });

  it("a retry never clobbers a newer queued edit for the same id (#53)", async () => {
    // First attempt rejects with "v1" queued; a newer "v2" is queued during the
    // backoff. The retry must persist "v2", and "v1" must never be written.
    invokeMock.mockRejectedValueOnce(new Error("EIO"));
    invokeMock.mockResolvedValue(undefined);

    const s = new AutoSaver(100, undefined, 5, 400);
    s.queue("a", "v1");
    await vi.advanceTimersByTimeAsync(150); // first attempt fails
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "save_pad", {
      id: "a",
      content: "v1",
    });

    s.queue("a", "v2"); // newer edit arrives during backoff
    await vi.advanceTimersByTimeAsync(450); // retry runs with latest content
    await s.flushAll();

    // Only one successful write, and it carries the NEWER content.
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "save_pad");
    expect(calls[calls.length - 1]).toEqual([
      "save_pad",
      { id: "a", content: "v2" },
    ]);
    // No call ever re-wrote the stale "v1" after the failure.
    const v1Writes = calls.filter((c) => c[1].content === "v1");
    expect(v1Writes).toHaveLength(1); // only the original failed attempt
  });

  it("cancel stops a retry loop so no later write resurrects (#52)", async () => {
    // The save keeps failing; cancel() during the backoff must kill the loop so
    // nothing is ever written afterwards.
    invokeMock.mockRejectedValue(new Error("EACCES"));

    const s = new AutoSaver(100, undefined, 5, 400);
    s.queue("a", "x");
    await vi.advanceTimersByTimeAsync(150); // first attempt fails -> backoff
    expect(invokeMock).toHaveBeenCalledTimes(1);

    s.cancel("a"); // abort the in-flight retry loop
    await vi.advanceTimersByTimeAsync(5_000); // well past any backoff/retries

    // No further attempts after the cancelled one.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("idle wakes and stops a retry loop (no resurrection after idle) (#52)", async () => {
    invokeMock.mockRejectedValue(new Error("EIO"));

    const s = new AutoSaver(100, undefined, 5, 400);
    s.queue("a", "x");
    await vi.advanceTimersByTimeAsync(150); // first attempt fails -> backoff
    expect(invokeMock).toHaveBeenCalledTimes(1);

    s.cancel("a");
    await s.idle("a"); // must resolve promptly despite the pending backoff
    await vi.advanceTimersByTimeAsync(5_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("flushAll rejects (not silently succeeds) when every attempt fails (#49)", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));

    const s = new AutoSaver(100, undefined, 3, 50);
    s.queue("a", "x");

    const flushing = s.flushAll();
    const settled = flushing.then(
      () => "resolved",
      () => "rejected",
    );
    // Run out the debounce + all bounded retries.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBe("rejected");
  });
});
