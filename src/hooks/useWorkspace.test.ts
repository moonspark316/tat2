import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so importing the hook module (which transitively pulls
// in `../storage`, which imports `@tauri-apps/api/core`) never touches a real
// backend. The pure index transitions under test don't call `invoke`, but the
// AutoSaver durability test below drives it directly.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { appendActivePad, removePadFromIndex } from "./useWorkspace";
import { AutoSaver } from "../storage";
import type { Index, PadMeta } from "../types";

function pad(id: string, order: number): PadMeta {
  return {
    id,
    title: id,
    color: "amber",
    order,
    createdAt: 0,
    updatedAt: 0,
  };
}

function index(ids: string[], activePadId: string | null): Index {
  return {
    version: 1,
    activePadId,
    pads: ids.map((id, i) => pad(id, i)),
    settings: {},
  };
}

// ---------------------------------------------------------------------------
// #59 / #61 — appendActivePad must apply to the LATEST index, never a stale one
// captured before an await (restoreFromTrash / importPad / addPad).
// ---------------------------------------------------------------------------
describe("appendActivePad (#59/#61: no stale-index clobber)", () => {
  it("appends to the latest index and makes the new pad active", () => {
    const next = appendActivePad(index(["a"], "a"), pad("b", 99));
    expect(next.pads.map((p) => p.id)).toEqual(["a", "b"]);
    expect(next.activePadId).toBe("b");
  });

  it("preserves a pad CREATED during the await (functional re-snapshot)", () => {
    // Captured-before-await state was {a}. While restorePad/import was in flight,
    // the user created pad `c`, so the LATEST state is {a, c}. Appending the
    // restored/imported `b` against the latest must KEEP `c` — the #59/#61 bug
    // wrote back the captured {a} and silently dropped `c`.
    const latest = index(["a", "c"], "c");
    const next = appendActivePad(latest, pad("b", 0));
    expect(next.pads.map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(next.activePadId).toBe("b");
  });

  it("re-derives order from the latest pad count, not a stale length", () => {
    // The captured index had length 1; by commit time it has 3. The new pad
    // must land at order 3 (end), not the stale 1.
    const latest = index(["a", "c", "d"], "a");
    const next = appendActivePad(latest, { ...pad("b", 1) });
    expect(next.pads.find((p) => p.id === "b")?.order).toBe(3);
  });

  it("does not mutate the input index", () => {
    const latest = index(["a"], "a");
    const before = JSON.stringify(latest);
    appendActivePad(latest, pad("b", 0));
    expect(JSON.stringify(latest)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// #60 / #61 — removePadFromIndex must use the LATEST active selection, not a
// stale `activeId` captured before the trash await.
// ---------------------------------------------------------------------------
describe("removePadFromIndex (#60/#61: no stale activeId)", () => {
  it("removes the pad and keeps a non-active selection untouched", () => {
    const next = removePadFromIndex(index(["a", "b", "c"], "b"), "a");
    expect(next.pads.map((p) => p.id)).toEqual(["b", "c"]);
    expect(next.activePadId).toBe("b");
  });

  it("falls back to the first remaining pad when the removed pad was active", () => {
    const next = removePadFromIndex(index(["a", "b", "c"], "a"), "a");
    expect(next.pads.map((p) => p.id)).toEqual(["b", "c"]);
    expect(next.activePadId).toBe("b");
  });

  it("respects an active switch that happened DURING the trash await (#60)", () => {
    // Captured-before-await activeId was the pad being removed ("a"). While the
    // trash was in flight the user switched to "c". Applied to the LATEST index
    // (activePadId "c"), removing "a" must NOT reset the active pad — the stale
    // capture would have forced active back to the first remaining pad ("b").
    const latest = index(["a", "b", "c"], "c");
    const next = removePadFromIndex(latest, "a");
    expect(next.activePadId).toBe("c");
  });

  it("preserves a pad ADDED during the trash await (#61)", () => {
    // While trashing "a", the user added "d". The latest index is {a,b,c,d};
    // removing "a" against it must keep "d".
    const latest = index(["a", "b", "c", "d"], "b");
    const next = removePadFromIndex(latest, "a");
    expect(next.pads.map((p) => p.id)).toEqual(["b", "c", "d"]);
  });

  it("is a no-op when the pad was already removed concurrently", () => {
    const latest = index(["b", "c"], "b");
    const next = removePadFromIndex(latest, "a");
    // Returns the same reference so the caller can skip the redundant persist.
    expect(next).toBe(latest);
  });

  it("does not mutate the input index", () => {
    const latest = index(["a", "b"], "a");
    const before = JSON.stringify(latest);
    removePadFromIndex(latest, "a");
    expect(JSON.stringify(latest)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// #58 — addPad / importPad route their initial content write through
// `saver.enqueue(...)` instead of a fire-and-forget `savePadDocNow`. The
// behavioural guarantees that buys us are (a) the write is serialized on the
// pad's per-id chain so it can't race a fast first edit to the same files, and
// (b) the returned promise is awaitable and surfaces failures (the caller can
// observe/log a rejection) rather than a fire-and-forget call that silently
// swallows errors. This exercises the exact mechanism those callbacks now use.
// ---------------------------------------------------------------------------
describe("saver.enqueue durability (#58 mechanism)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces a failed initial write as a rejection (not fire-and-forget)", async () => {
    const persist = vi
      .fn<(id: string, content: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk busy"));
    const saver = new AutoSaver(400, persist);

    // Mirror addPad/importPad: enqueue the initial content write on the per-id
    // chain rather than firing and forgetting. The promise rejects so the
    // caller's `.catch(...)` can log it — a true fire-and-forget would drop it.
    await expect(
      saver.enqueue("pad-1", () => persist("pad-1", "seed")),
    ).rejects.toThrow("disk busy");
    expect(persist).toHaveBeenCalledWith("pad-1", "seed");
  });

  it("serializes the initial write before a fast first edit to the same pad", async () => {
    const order: string[] = [];
    let releaseSeed!: () => void;
    const seedGate = new Promise<void>((r) => {
      releaseSeed = r;
    });
    const persist = vi.fn(async (_id: string, content: string) => {
      if (content === "seed") {
        order.push("seed-start");
        await seedGate;
        order.push("seed-end");
      } else {
        order.push(`edit:${content}`);
      }
    });
    const saver = new AutoSaver(50, persist);

    // Initial pad write (what addPad/importPad enqueue)...
    const seedDone = saver.enqueue("pad-1", () => persist("pad-1", "seed"));
    // ...and an immediate first keystroke to the same pad.
    saver.queue("pad-1", "v1");
    await vi.advanceTimersByTimeAsync(100);
    // The seed is still in flight; release it and let the edit run.
    releaseSeed();
    await seedDone;
    await saver.flushAll();

    // The edit must run strictly AFTER the seed finishes — never interleaved.
    expect(order).toEqual(["seed-start", "seed-end", "edit:v1"]);
  });
});
