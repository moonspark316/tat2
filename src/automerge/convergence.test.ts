/**
 * Conflict-free merge test suite (#21).
 *
 * Property/simulation tests proving NO DATA LOSS under concurrent, multi-device
 * editing. We simulate N devices that each make random interleaved edits, then
 * deliver every device's changes to every other device in random orders — with
 * duplicates and reordering — and assert:
 *
 *   1. All devices converge to the SAME Automerge text.
 *   2. The `.md` mirror (what the app writes alongside the binary) equals the
 *      converged doc's text — i.e. round-tripping through save → load → getText
 *      reproduces the exact converged content.
 *
 * Everything is seeded (PRNG + Automerge actor ids) so a failing run is exactly
 * reproducible from its seed.
 */

import { describe, expect, it } from "vitest";
import {
  getText,
  loadDoc,
  mergeBytes,
  type PadDoc,
  saveDoc,
  seedDoc,
  setText,
} from "./padDoc";
import { actorForDevice, mutate, Rng } from "./testRandom";

interface SimResult {
  /** The converged text every device agreed on. */
  text: string;
  /** Per-device final text (should all be identical). */
  perDevice: string[];
}

/**
 * Run one simulation.
 *
 * @param seed       PRNG seed (also derives a per-run base).
 * @param devices    number of simulated devices.
 * @param rounds     edit rounds; each round each device may make a local edit.
 * @param dupFactor  how many extra duplicate deliveries to inject.
 */
function simulate(
  seed: number,
  devices: number,
  rounds: number,
  dupFactor: number,
): SimResult {
  const rng = new Rng(seed);

  // All devices start from the same seed document (a shared initial pad).
  const seedDocBytes = saveDoc(seedDoc("start", actorForDevice(0xfff)));
  const docs: PadDoc[] = [];
  for (let d = 0; d < devices; d++) {
    docs.push(loadDoc(seedDocBytes, actorForDevice(d)));
  }

  // Each emitted "message" is a snapshot of a device's doc after a local edit.
  // (Snapshots are idempotent to merge, like full Automerge change bundles.)
  const messages: Uint8Array[] = [];

  for (let r = 0; r < rounds; r++) {
    for (let d = 0; d < devices; d++) {
      // Each device edits with ~70% probability per round, so interleavings vary.
      if (!rng.chance(0.7)) continue;
      const before = getText(docs[d]);
      const after = mutate(rng, before);
      docs[d] = setText(docs[d], after, actorForDevice(d));
      messages.push(saveDoc(docs[d]));
    }
  }

  // Build a chaotic delivery schedule: every message at least once, plus
  // duplicates, all shuffled (reordered).
  let schedule = messages.slice();
  for (let i = 0; i < dupFactor; i++) {
    const extra = rng.int(messages.length);
    schedule.push(messages[extra]);
  }
  schedule = rng.shuffle(schedule);

  // Deliver the (shuffled, duplicated) schedule to EVERY device. Each device
  // gets its own independent shuffle so no two devices see the same order.
  for (let d = 0; d < devices; d++) {
    const order = rng.shuffle(schedule);
    for (const msg of order) {
      docs[d] = mergeBytes(docs[d], msg);
    }
  }

  // Mirror check: the persisted binary, reloaded, must reproduce the same text
  // the app would have written to `pads/<id>.md`.
  const perDevice = docs.map((doc) => {
    const text = getText(doc);
    const reloaded = getText(loadDoc(saveDoc(doc)));
    expect(reloaded).toBe(text); // save/load round-trip is lossless
    return text;
  });

  return { text: perDevice[0], perDevice };
}

describe("CRDT convergence (#21)", () => {
  // A spread of seeds + topologies. Each is fully deterministic.
  const cases: Array<[number, number, number]> = [
    [1, 2, 8],
    [2, 3, 10],
    [7, 4, 12],
    [42, 5, 15],
    [123, 6, 10],
    [999, 8, 8],
  ];

  for (const [seed, devices, rounds] of cases) {
    it(`converges with ${devices} devices, ${rounds} rounds (seed ${seed})`, () => {
      const { perDevice } = simulate(seed, devices, rounds, devices * 3);
      // Every device agrees.
      for (const t of perDevice) expect(t).toBe(perDevice[0]);
    });
  }

  it("is order-independent: shuffled delivery yields the same result every time", () => {
    // Same seed -> identical converged text across repeated runs.
    const a = simulate(2024, 5, 12, 20);
    const b = simulate(2024, 5, 12, 20);
    expect(a.text).toBe(b.text);
    for (const t of a.perDevice) expect(t).toBe(a.text);
  });

  it("never loses a device's contribution under heavy duplication", () => {
    // Two devices, disjoint markers; both markers must survive convergence.
    const seedBytes = saveDoc(seedDoc("", actorForDevice(0xfff)));
    let d1 = loadDoc(seedBytes, actorForDevice(1));
    let d2 = loadDoc(seedBytes, actorForDevice(2));

    d1 = setText(d1, "ALPHA", actorForDevice(1));
    d2 = setText(d2, "OMEGA", actorForDevice(2));

    const m1 = saveDoc(d1);
    const m2 = saveDoc(d2);

    // Deliver each message many times, in alternating order, to both devices.
    for (let i = 0; i < 25; i++) {
      d1 = mergeBytes(d1, i % 2 ? m2 : m1);
      d2 = mergeBytes(d2, i % 2 ? m1 : m2);
    }
    expect(getText(d1)).toBe(getText(d2));
    const converged = getText(d1);
    // Both contributions survive (no last-write-wins clobber).
    expect(converged).toContain("ALPHA");
    expect(converged).toContain("OMEGA");
  });
});
