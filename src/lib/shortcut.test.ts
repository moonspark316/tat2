import { describe, expect, it } from "vitest";
import { buildAccelerator, displayShortcut } from "./shortcut";

// Minimal stand-in for a KeyboardEvent.
const ev = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  }) as KeyboardEvent;

describe("buildAccelerator", () => {
  it("returns null for a lone modifier press", () => {
    expect(buildAccelerator(ev({ code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(buildAccelerator(ev({ code: "MetaLeft", metaKey: true }))).toBeNull();
  });

  it("returns null when no modifier is held", () => {
    expect(buildAccelerator(ev({ code: "KeyN" }))).toBeNull();
  });

  it("builds a Tauri-style accelerator with modifiers in canonical order", () => {
    expect(
      buildAccelerator(
        ev({ code: "KeyN", metaKey: true, shiftKey: true }),
      ),
    ).toBe("Shift+Super+KeyN");
    expect(buildAccelerator(ev({ code: "Space", ctrlKey: true }))).toBe(
      "Control+Space",
    );
  });

  it("maps meta to Super and supports digits", () => {
    expect(buildAccelerator(ev({ code: "Digit1", metaKey: true }))).toBe(
      "Super+Digit1",
    );
  });
});

describe("displayShortcut", () => {
  it("prettifies tokens into a readable label", () => {
    // In the (non-mac) test env, Control renders as 'Ctrl'.
    expect(displayShortcut("Control+Shift+KeyN")).toBe("Ctrl ⇧ N");
    expect(displayShortcut("Control+Space")).toBe("Ctrl Space");
    expect(displayShortcut("Control+Digit1")).toBe("Ctrl 1");
  });
});
