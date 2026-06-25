import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { PadDocStore } from "./store";
import { seedDoc, saveDoc } from "./padDoc";
import type { Workspace } from "../types";

const ACTOR = "00000000000000aa";

function ws(
  pads: Array<{ id: string }>,
  contents: Record<string, string>,
  docs: Record<string, number[]> = {},
): Workspace {
  return {
    index: {
      version: 1,
      activePadId: pads[0]?.id ?? null,
      pads: pads.map((p, i) => ({
        id: p.id,
        title: "t",
        color: "amber",
        order: i,
        createdAt: 0,
        updatedAt: 0,
      })),
      settings: {},
    },
    contents,
    docs,
  };
}

describe("PadDocStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("migrates pads with only .md by seeding a doc from the text", () => {
    const store = new PadDocStore(ACTOR);
    const migrated = store.hydrate(ws([{ id: "a" }], { a: "hello" }));
    expect(migrated).toEqual(["a"]);
    expect(store.text("a")).toBe("hello");
  });

  it("loads existing .automerge binaries instead of re-seeding", () => {
    const bytes = Array.from(saveDoc(seedDoc("from-binary", ACTOR)));
    const store = new PadDocStore(ACTOR);
    // The common case: the `.md` mirror is in sync with the binary.
    const migrated = store.hydrate(
      ws([{ id: "a" }], { a: "from-binary" }, { a: bytes }),
    );
    expect(migrated).toEqual([]); // not a migration; binary already existed
    expect(store.text("a")).toBe("from-binary");
  });

  it("heals a lagging binary by folding the newer .md text back in", () => {
    // Binary says "old", but the (authoritative) .md says "old + recovered".
    const bytes = Array.from(saveDoc(seedDoc("old", ACTOR)));
    const store = new PadDocStore(ACTOR);
    const migrated = store.hydrate(
      ws([{ id: "a" }], { a: "old + recovered" }, { a: bytes }),
    );
    // Flagged for re-persist, and the recoverable .md text wins.
    expect(migrated).toEqual(["a"]);
    expect(store.text("a")).toBe("old + recovered");
  });

  it("applyEdit records the change and yields persistable bytes + text", () => {
    const store = new PadDocStore(ACTOR);
    store.hydrate(ws([{ id: "a" }], { a: "" }));
    const { bytes, content } = store.applyEdit("a", "typed");
    expect(content).toBe("typed");
    expect(bytes.length).toBeGreaterThan(0);
    expect(store.text("a")).toBe("typed");
  });

  it("persistFn folds text into the doc and calls save_pad_doc with the binary", async () => {
    const store = new PadDocStore(ACTOR);
    store.hydrate(ws([{ id: "a" }], { a: "" }));
    await store.persistFn("a", "world");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("save_pad_doc");
    expect(args.id).toBe("a");
    expect(args.content).toBe("world");
    expect(Array.isArray(args.doc)).toBe(true);
    expect(args.doc.length).toBeGreaterThan(0);
  });

  it("merge converges two stores editing the same pad", () => {
    const a = new PadDocStore("00000000000000a1");
    const b = new PadDocStore("00000000000000b2");
    const seed = ws([{ id: "p" }], { p: "base" });
    a.hydrate(seed);
    b.hydrate(seed);
    // Diverge.
    a.applyEdit("p", "base-A");
    b.applyEdit("p", "base-B");
    // Cross-merge.
    const aText = a.merge("p", b.bytes("p")!);
    const bText = b.merge("p", a.bytes("p")!);
    expect(aText).toBe(bText);
  });

  it("forget drops a pad's doc", () => {
    const store = new PadDocStore(ACTOR);
    store.hydrate(ws([{ id: "a" }], { a: "x" }));
    expect(store.has("a")).toBe(true);
    store.forget("a");
    expect(store.has("a")).toBe(false);
  });
});
