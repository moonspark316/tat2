// Pure fit-math for the dot-strip overflow chip (#69).
//
// The strip renders `[dots that fit] [ +N chip ] [ + add ]`. This module
// answers one question with no DOM/React involved (so it's unit-testable):
// given the measured width of the `.dots` container and the geometry of its
// children, how many dots do we keep as real dots, and do we show the chip?
//
// It is a *rendering* concern only — it never touches index.json / PadMeta.

/** Geometry of the strip, in px. Defaults mirror App.css (.dot 16px, gap 12px,
 *  .dot.add 16px). The chip reuses the same 16px footprint as a dot. */
export interface DotFitGeometry {
  /** Diameter of a single color dot. App.css `.dot { width:16px }`. */
  dot: number;
  /** Flex `gap` between strip children. App.css `.dots { gap:12px }`. */
  gap: number;
  /** Width of the trailing `+` add button (`.dot.add`, same 16px box). */
  add: number;
  /** Width of the `+N` overflow chip when shown (~a dot's footprint). */
  chip: number;
}

export const DEFAULT_GEOMETRY: DotFitGeometry = {
  dot: 16,
  gap: 12,
  add: 16,
  chip: 16,
};

export interface DotFitResult {
  /** How many pads to render as real dots (before the chip). */
  visibleCount: number;
  /** Whether to render the `+N` overflow chip. */
  showChip: boolean;
  /** How many pads are folded into the chip (`+N`). 0 when `showChip` false. */
  overflowCount: number;
}

/** Width consumed by `n` items laid out with `gap` between them (0 => 0). */
function rowWidth(n: number, item: number, gap: number): number {
  if (n <= 0) return 0;
  return n * item + (n - 1) * gap;
}

/**
 * Decide how many dots fit and whether to spill into a `+N` chip.
 *
 * @param total     number of visible (non-archived) pads to place
 * @param available measured inner width of the `.dots` container, in px
 * @param geo       strip geometry (defaults to App.css values)
 *
 * Layout budget: the add button is always present, so it (plus its gap) is
 * reserved up front. We then greedily fit dots. If they all fit, no chip.
 *
 * ANTI-FLICKER THRESHOLD (issue #69 edge case): hiding a single pad to show a
 * "+1" chip is pointless — the chip occupies the same ~16px a dot would, so you
 * gain nothing and just add visual noise. So we only spill into the chip when it
 * genuinely buys space: the chip must replace at least TWO dots (overflowCount
 * >= 2). If exactly one dot wouldn't fit, we instead check whether that last dot
 * fits in the space the chip would have taken (it does — same footprint) and
 * keep it as a plain dot with no chip. In practice: never show "+1".
 */
export function computeDotFit(
  total: number,
  available: number,
  geo: DotFitGeometry = DEFAULT_GEOMETRY,
): DotFitResult {
  if (total <= 0) {
    return { visibleCount: 0, showChip: false, overflowCount: 0 };
  }

  // The add button is always drawn; reserve it (and the gap that precedes it
  // once there's at least one dot). We fold the add's gap into the per-dot cost
  // by first checking the all-fit case explicitly.
  const allDotsWidth = rowWidth(total, geo.dot, geo.gap);
  const addBudget = geo.add + (total > 0 ? geo.gap : 0);
  if (allDotsWidth + addBudget <= available) {
    return { visibleCount: total, showChip: false, overflowCount: 0 };
  }

  // Not everything fits. Reserve room for the chip AND the add button, then fit
  // as many dots as the remaining width allows. Each dot after the first costs
  // an extra gap; the chip and add each also cost a preceding gap.
  const reserved = geo.chip + geo.gap + geo.add + geo.gap;
  const room = available - reserved;

  // Max dots that fit in `room`: solve n*dot + (n-1)*gap <= room  =>
  // n <= (room + gap) / (dot + gap). Clamp to [0, total].
  let fit =
    room <= 0 ? 0 : Math.floor((room + geo.gap) / (geo.dot + geo.gap));
  fit = Math.max(0, Math.min(fit, total));

  let overflow = total - fit;

  // Anti-flicker: never show "+1". If only one dot would be hidden, the chip
  // saves no space (same footprint) — keep it as a dot and drop the chip.
  if (overflow === 1) {
    return { visibleCount: total, showChip: false, overflowCount: 0 };
  }

  if (overflow <= 0) {
    return { visibleCount: total, showChip: false, overflowCount: 0 };
  }

  return { visibleCount: fit, showChip: true, overflowCount: overflow };
}

/**
 * Select which pad ids stay as dots, keeping the ACTIVE pad always visible.
 *
 * `orderedIds` is the visible pads in strip order. `visibleCount` is how many
 * dots we can draw (from `computeDotFit`). Normally we take the first
 * `visibleCount` ids. But the pad being edited must never be hidden (#69): if
 * the active pad sorts past the fit window, we pin it as the LAST visible dot
 * (dropping the id that would otherwise have been last) so it stays on the strip
 * without changing the dot count.
 *
 * Returns the ids to render as dots, in display order. When the active pad is
 * pinned in from beyond the window, it appears last (right before the chip).
 */
export function selectVisibleDots(
  orderedIds: string[],
  visibleCount: number,
  activeId: string | null,
): string[] {
  const activePresent = activeId !== null && orderedIds.includes(activeId);
  // Graceful narrow-width floor: if the fit math says zero dots but there IS an
  // active pad, still show it — we never hide the pad being edited (#69). The
  // strip then degrades to just the active dot + chip + add.
  const floor = activePresent ? 1 : 0;
  const count = Math.max(floor, Math.min(visibleCount, orderedIds.length));
  const head = orderedIds.slice(0, count);
  if (!activePresent || count === 0) return head;
  if (head.includes(activeId!)) return head;
  // Active pad is beyond the window — pin it as the last visible dot, dropping
  // the current last to keep the count stable.
  return [...head.slice(0, count - 1), activeId!];
}
