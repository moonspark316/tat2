import { describe, expect, it } from "vitest";
import {
  docHistory,
  getText,
  loadDoc,
  mergeBytes,
  mergeDocs,
  saveDoc,
  seedDoc,
  setText,
  textAtHistoryIndex,
} from "./padDoc";

describe("padDoc", () => {
  it("seeds a doc whose text equals the seed string", () => {
    const doc = seedDoc("hello world", "aaaaaaaaaaaaaaaa");
    expect(getText(doc)).toBe("hello world");
  });

  it("round-trips through save/load preserving text", () => {
    const doc = seedDoc("# Title\n\nbody", "aaaaaaaaaaaaaaaa");
    const bytes = saveDoc(doc);
    const back = loadDoc(bytes, "bbbbbbbbbbbbbbbb");
    expect(getText(back)).toBe("# Title\n\nbody");
  });

  it("setText records a change and updates the text", () => {
    let doc = seedDoc("abc", "aaaaaaaaaaaaaaaa");
    const before = docHistory(doc).length;
    doc = setText(doc, "abcdef", "aaaaaaaaaaaaaaaa");
    expect(getText(doc)).toBe("abcdef");
    expect(docHistory(doc).length).toBe(before + 1);
  });

  it("setText is a no-op (no new change) when text is unchanged", () => {
    const doc = seedDoc("same", "aaaaaaaaaaaaaaaa");
    const before = docHistory(doc).length;
    const after = setText(doc, "same", "aaaaaaaaaaaaaaaa");
    expect(docHistory(after).length).toBe(before);
    expect(after).toBe(doc);
  });

  it("merges concurrent character-level edits without data loss", () => {
    const seed = seedDoc("hello world", "0000000000000000");
    const bytes = saveDoc(seed);
    let d1 = loadDoc(bytes, "1111111111111111");
    let d2 = loadDoc(bytes, "2222222222222222");

    // d1 inserts in the middle; d2 appends at the end — both must survive.
    d1 = setText(d1, "hello BIG world", "1111111111111111");
    d2 = setText(d2, "hello world!", "2222222222222222");

    const m1 = mergeDocs(d1, d2);
    const m2 = mergeDocs(d2, d1);
    expect(getText(m1)).toBe(getText(m2));
    expect(getText(m1)).toBe("hello BIG world!");
  });

  it("mergeBytes is idempotent under duplicate delivery", () => {
    const seed = seedDoc("base", "0000000000000000");
    let d1 = loadDoc(saveDoc(seed), "1111111111111111");
    let d2 = loadDoc(saveDoc(seed), "2222222222222222");
    d2 = setText(d2, "base+remote", "2222222222222222");
    const remoteBytes = saveDoc(d2);

    d1 = mergeBytes(d1, remoteBytes);
    const once = getText(d1);
    d1 = mergeBytes(d1, remoteBytes); // duplicate
    expect(getText(d1)).toBe(once);
  });

  it("textAtHistoryIndex recovers older revisions", () => {
    let doc = seedDoc("v1", "aaaaaaaaaaaaaaaa");
    doc = setText(doc, "v1v2", "aaaaaaaaaaaaaaaa");
    expect(textAtHistoryIndex(doc, 0)).toBe("v1");
    expect(textAtHistoryIndex(doc, docHistory(doc).length - 1)).toBe("v1v2");
  });
});
