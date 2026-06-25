/**
 * The Automerge document model for a single pad (epic #3, issue #16).
 *
 * Each pad's content is an Automerge document with one text field, `content`.
 * In Automerge v3 a plain JS `string` value IS a character-level text CRDT —
 * edited with {@link Automerge.splice}/{@link Automerge.updateText} it merges
 * concurrent edits without a last-write-wins data-loss cliff. (The v2-era
 * `Automerge.Text` class no longer exists; a `string` field is the v3-correct
 * realization of the design doc's "Automerge.Text/splice on a `content` field".)
 *
 * Responsibilities of this module:
 *   - seed a fresh doc from an existing `.md` string (migration, #16),
 *   - load/save the binary form persisted as `pads/<id>.automerge`,
 *   - apply local text edits as Automerge changes,
 *   - merge remote docs / changes (the convergence guarantee tested by #21),
 *   - expose the doc's text so it can be mirrored back to `pads/<id>.md`.
 *
 * The CRDT lives here in TypeScript; the Rust layer only stores the opaque
 * binary alongside the `.md` mirror. The `.md` file always remains the
 * human-recoverable source of truth and is never bypassed.
 */

import * as Automerge from "@automerge/automerge";
import { deviceActorId } from "./actor";

/** Shape of a pad's Automerge document. `content` is a text-CRDT string. */
export interface PadDocShape {
  content: string;
}

export type PadDoc = Automerge.Doc<PadDocShape>;

/** The single field path all pad text lives under. */
const CONTENT_PATH: Automerge.Prop[] = ["content"];

/** Options for constructing/loading a doc, allowing a deterministic actor id. */
function initOpts(actor?: string): Automerge.InitOptions<PadDocShape> {
  return { actor: actor ?? deviceActorId() };
}

/**
 * Create a brand-new pad doc seeded with `text`.
 *
 * Used both for new pads and for migrating an existing `pads/<id>.md` string
 * into the CRDT on first launch after upgrade — the old `.md` becomes the seed
 * change, so nothing is lost and the `.md` remains byte-identical until the
 * user next edits.
 */
export function seedDoc(text: string, actor?: string): PadDoc {
  const empty = Automerge.init<PadDocShape>(initOpts(actor));
  return Automerge.change(empty, (d) => {
    // Initialise the field as a string, then splice the seed text in so it is
    // a true text CRDT from the very first change (mergeable per-character).
    d.content = "";
    if (text.length > 0) {
      Automerge.splice(d, CONTENT_PATH, 0, 0, text);
    }
  });
}

/** Serialize a doc to its compressed binary form for `pads/<id>.automerge`. */
export function saveDoc(doc: PadDoc): Uint8Array {
  return Automerge.save(doc);
}

/**
 * Load a doc from its binary form, binding it to this device's (or a given)
 * actor id so subsequent local edits are attributed correctly.
 */
export function loadDoc(bytes: Uint8Array, actor?: string): PadDoc {
  return Automerge.load<PadDocShape>(bytes, initOpts(actor));
}

/** The current text of a pad doc (what gets mirrored to `pads/<id>.md`). */
export function getText(doc: PadDoc): string {
  return doc.content ?? "";
}

/**
 * Apply a new full-text value to the doc as an Automerge change.
 *
 * We diff against the doc's current text and turn the difference into splices
 * (via {@link Automerge.updateText}) rather than replacing the whole string, so
 * an edit that touches the middle of the document merges cleanly with a
 * concurrent edit elsewhere. Returns the new immutable doc; if the text is
 * unchanged the same doc is returned (no empty change is recorded).
 */
export function setText(doc: PadDoc, text: string, actor?: string): PadDoc {
  if (getText(doc) === text) return doc;
  // Ensure local changes are attributed to the right actor even if the doc was
  // just merged/loaded with a different one.
  const wanted = actor ?? deviceActorId();
  const bound =
    Automerge.getActorId(doc) === wanted
      ? doc
      : Automerge.clone(doc, initOpts(wanted));
  return Automerge.change(bound, (d) => {
    if (typeof d.content !== "string") d.content = "";
    Automerge.updateText(d, CONTENT_PATH, text);
  });
}

/**
 * Merge `remote` into `local`, returning the converged doc. Idempotent and
 * order-independent — re-merging the same doc, or merging in a different order,
 * yields the same result. This is the property #21 exercises at scale.
 */
export function mergeDocs(local: PadDoc, remote: PadDoc): PadDoc {
  return Automerge.merge(local, remote);
}

/**
 * Merge another device's serialized doc bytes into `local`. Tolerant of
 * duplicate / out-of-order delivery (Automerge changes are idempotent).
 */
export function mergeBytes(local: PadDoc, bytes: Uint8Array): PadDoc {
  const remote = Automerge.load<PadDocShape>(bytes);
  return Automerge.merge(local, remote);
}

/** A point in the doc's edit history, mapped to a timestamp + resulting text. */
export interface PadRevision {
  /** Change hash (stable id of this revision). */
  hash: string;
  /** Wall-clock time of the change in epoch-ms, if recorded (else 0). */
  time: number;
  /** Author actor id of the change. */
  actor: string;
}

/**
 * The pad's revision history derived from Automerge (issue #11/#15 can migrate
 * onto this). Ordered oldest-first, matching the existing snapshot ordering.
 */
export function docHistory(doc: PadDoc): PadRevision[] {
  return Automerge.getHistory(doc).map((state) => ({
    hash: state.change.hash ?? "",
    // Automerge records time in seconds; normalise to epoch-ms. 0 means "unset".
    time: state.change.time ? state.change.time * 1000 : 0,
    actor: state.change.actor ?? "",
  }));
}

/**
 * Recover the doc's text as of a given history index (oldest-first), used to
 * preview/restore an older revision without mutating the live doc.
 */
export function textAtHistoryIndex(doc: PadDoc, index: number): string {
  const history = Automerge.getHistory(doc);
  const state = history[index];
  return state ? (state.snapshot.content ?? "") : "";
}
