// Plain-language copy for the two real reasons an anchor commute can be
// unreachable (bearings/profile.py's NO_STATION_IN_RANGE / NO_RAIL_
// CONNECTION -- see that module's `_anchor_result()` docstring for exactly
// how each is decided). Added 2026-07-18 to replace a single collapsed
// "no route found" string that rendered identically whether the cause was
// a genuine transit desert or a real, permanent Staten Island Railway ferry
// gap -- see this project's 2026-07-18 "no-route-copy-split" agent-report.
//
// Shared by CellReportView.tsx and TransitCard.tsx rather than duplicated
// in each -- the backend's own no-route-reason fix specifically called out
// duplicated logic (profile.py's `_to_anchors()` and cellprofile.py's
// `_transit_by_cell()` had independently reimplemented the same minutes
// computation) as the root of the original bug, so this file exists to
// avoid the frontend repeating that mistake with copy instead of logic.
import type { UnreachableReason } from "../types";

// A short label for the per-anchor bar row's own value slot -- same visual
// slot a real "23 min" value sits in, so this has to stay short and
// tabular (VISUAL.md's tDR-derived information density), not a full
// sentence. The full explanation lives in unreachableReasonSentence() below,
// shown once per distinct reason actually present, not once per anchor.
export function unreachableReasonShortLabel(reason: UnreachableReason): string {
  switch (reason) {
    case "no_station_in_range":
      return "no station nearby";
    case "no_rail_connection":
      return "no rail link";
  }
}

// The full, plain-language explanation for one reason -- says what's
// actually true rather than implying the neighborhood has no way to get
// around:
//   - no_station_in_range states the real search radius (STATION_SEARCH_M
//     = 1200m, ~15 minutes' walk at WALK_SPEED_MPS) and is explicit that
//     this project's transit feed is subway + PATH only, no bus -- "no
//     subway or PATH station nearby" is true where "no way to get around"
//     would be false and unfair to a bus-served block.
//   - no_rail_connection names Staten Island Railway specifically, which is
//     safe to hardcode here (not a guess): the backend's own
//     `_disconnected_stop_ids()` (profile.py) asserts, every time it runs,
//     that every station this reason code is ever attached to serves ONLY
//     the real "SIR" route -- if that ever stopped being true (a future
//     GTFS change or code regression), the backend raises
//     UnexplainedDisconnectedStation and the whole bake fails loudly,
//     rather than silently reaching this frontend as a mislabeled "ferry
//     gap" on a route that was actually just broken.
export function unreachableReasonSentence(reason: UnreachableReason): string {
  switch (reason) {
    case "no_station_in_range":
      return (
        "No subway or PATH station within about a 15-minute walk. This " +
        "report only covers the subway and PATH -- it doesn't check bus " +
        "routes, so a block with real bus service can still show this."
      );
    case "no_rail_connection":
      return (
        "The nearest stations here are on the Staten Island Railway, " +
        "which has no rail connection to the rest of the subway and PATH " +
        "network -- getting there needs the Staten Island Ferry, and " +
        "ferry schedules aren't part of this data. That's a gap in what " +
        "this report can calculate, not a sign the area itself is " +
        "unreachable."
      );
  }
}
