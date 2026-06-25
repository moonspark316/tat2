/**
 * Deterministic randomness helpers for the conflict-free merge simulations
 * (#21). Everything is seeded so CI runs are exactly reproducible — a failing
 * seed can be re-run to debug the precise interleaving that broke convergence.
 *
 * Not for production use; imported only by tests.
 */

/** mulberry32 — a tiny, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded RNG with convenience helpers. */
export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz \n#-*";

/**
 * Apply one random single-character-ish mutation to `text` and return the new
 * text. Models the kind of edits a person makes between autosaves: insert a
 * short run, delete a span, or replace a span. Operating on full-text values
 * (rather than raw splices) matches how the app actually persists — it diffs
 * the new text into Automerge splices via `updateText`.
 */
export function mutate(rng: Rng, text: string): string {
  const kind = rng.int(3);
  const pos = rng.int(text.length + 1);
  if (kind === 0 || text.length === 0) {
    // Insert a run of 1–4 chars.
    const len = 1 + rng.int(4);
    let ins = "";
    for (let i = 0; i < len; i++) ins += rng.pick(ALPHABET.split(""));
    return text.slice(0, pos) + ins + text.slice(pos);
  }
  if (kind === 1) {
    // Delete a span of 1–3 chars.
    const len = 1 + rng.int(3);
    return text.slice(0, pos) + text.slice(pos + len);
  }
  // Replace a span of 1–3 chars with a single char.
  const len = 1 + rng.int(3);
  return text.slice(0, pos) + rng.pick(ALPHABET.split("")) + text.slice(pos + len);
}

/** A valid 16-char hex actor id for device index `i`. */
export function actorForDevice(i: number): string {
  return i.toString(16).padStart(16, "0");
}
