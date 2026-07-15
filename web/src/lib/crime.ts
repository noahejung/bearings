// Crime is shaded/labelled RELATIVE to the rest of NYC, never as a bare
// absolute count (VISUAL.md §5, REVISED 2026-07-15): an unnormalised count
// partly maps population/commercial density, not risk, and on an absolute
// scale NYC's baseline is high everywhere, so even the safest precinct
// reads alarming. `crime_percentile` (bearings/citywide.py's
// percentile_rank(), see that module's own docstring for the exact method
// and the denominator decision -- percentile rank of the raw YTD count,
// not a per-capita rate, since no NYPD/NYC Open Data precinct-population
// table exists) is 0-100: 0 = fewest reported major crimes of any real NYC
// precinct, 100 = most, and the median precinct sits at (very close to) 50.
// This module is the one place both the safety card and the map's
// heat-map readout turn that number into the same plain-language framing.

export function ordinalSuffix(n: number): string {
  const rem100 = Math.abs(n) % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  switch (Math.abs(n) % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export function formatPercentile(p: number): string {
  const rounded = Math.round(p);
  return `${rounded}${ordinalSuffix(rounded)} percentile citywide`;
}

// Three buckets (tertiles), matching the design brief's own three-way
// framing verbatim ("lower than most NYC precincts / about typical /
// higher than most") -- not a finer five-point scale, which would imply
// more precision than a 78-precinct sample and a coarse-boundary count
// actually supports.
export function crimeRelativeLabel(p: number): string {
  if (p < 100 / 3) return "Fewer major crimes reported than most NYC precincts";
  if (p > 200 / 3) return "More major crimes reported than most NYC precincts";
  return "About typical for an NYC precinct";
}
