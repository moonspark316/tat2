/**
 * Per-device Automerge actor identity.
 *
 * Every Automerge change is attributed to an "actor" — a stable, opaque hex id
 * that distinguishes edits made on this device from edits that arrive (via a
 * synced folder or, later, the relay) from other devices. Two devices MUST have
 * different actor ids or their concurrent edits would be misattributed to the
 * same author and could fail to merge cleanly.
 *
 * Automerge requires actor ids to be a hex string of even length. We persist a
 * randomly-generated one in `localStorage` so it stays stable across launches
 * on a given device. Tests inject a deterministic id so runs are reproducible.
 */

const STORAGE_KEY = "tat2.automerge.actorId";

/** True if `s` is a valid Automerge actor id (non-empty, even-length hex). */
export function isValidActorId(s: string): boolean {
  return s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s);
}

/** Generate a fresh random 16-byte (32 hex char) actor id. */
export function randomActorId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The stable actor id for this device, created and persisted on first use.
 *
 * Falls back to an in-memory id if `localStorage` is unavailable (e.g. a
 * sandboxed context), which still keeps a single session internally consistent.
 */
let cached: string | null = null;

export function deviceActorId(): string {
  if (cached && isValidActorId(cached)) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && isValidActorId(existing)) {
      cached = existing;
      return existing;
    }
    const fresh = randomActorId();
    localStorage.setItem(STORAGE_KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    if (!cached) cached = randomActorId();
    return cached;
  }
}

/** Test-only: force a specific (or fresh) device actor id. */
export function __setDeviceActorIdForTest(id: string | null): void {
  cached = id;
}
