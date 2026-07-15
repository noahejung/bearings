// Relative scaling for the map's per-cell metrics (VISUAL.md §5, REVISED
// 2026-07-15): "Apply relative scaling (percentile, median-neutral -- the
// crime pattern) to any metric where absolute counts would mislead, not
// just crime." A single loud cell (e.g. one block with 40 grocery POIs
// next to 36 cells with a handful each) would otherwise swamp a plain
// value/max ramp -- the same "one outlier owns the whole scale" failure
// crime's own percentile fix (bearings/citywide.py's percentile_rank())
// already solved. This is the same mean-rank method, ported to TypeScript
// so the map can apply it client-side to metrics that only ever have a
// LOCAL reference population (the ~37 cells currently in view), not
// citywide.py's true 78-precinct citywide one.
//
// That distinction matters and is stated here plainly, not left implicit:
// crime's percentile is relative to every real NYC precinct. A cell
// metric's percentile computed by this function is relative only to the
// other cells in the current k=3 disk -- a real, honestly-computed number
// (never fabricated), just a smaller and address-dependent reference
// population. MapView.tsx's copy says "relative to this neighbourhood",
// never "citywide", for exactly this reason.

export function percentileRank(values: number[], v: number): number {
  const n = values.length;
  if (n === 0) {
    throw new Error("percentileRank of an empty distribution is undefined");
  }
  let below = 0;
  let equal = 0;
  for (const x of values) {
    if (x < v) below += 1;
    else if (x === v) equal += 1;
  }
  return (100 * (below + 0.5 * equal)) / n;
}
