const IS_MAC = navigator.userAgent.includes("Mac");

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export const defaultShortcut = IS_MAC
  ? "Super+Shift+Space"
  : "Ctrl+Shift+Space";

/**
 * Build a Tauri-parseable accelerator (e.g. "Super+Shift+KeyN") from a keydown
 * event. Returns null until a non-modifier key is pressed with a modifier held.
 */
export function buildAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (mods.length === 0) return null; // require at least one modifier
  return [...mods, e.code].join("+");
}

/** Pretty, platform-aware label for an accelerator. */
export function displayShortcut(accel: string): string {
  return accel
    .replace(/Super/g, IS_MAC ? "⌘" : "⊞")
    .replace(/Control/g, IS_MAC ? "⌃" : "Ctrl")
    .replace(/Shift/g, "⇧")
    .replace(/Alt/g, IS_MAC ? "⌥" : "Alt")
    .replace(/Key([A-Z])/g, "$1")
    .replace(/Digit(\d)/g, "$1")
    .replace(/\+/g, " ");
}
