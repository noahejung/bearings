import type { ToAnchors } from "../types";

// Mirrors bearings/config.py's ANCHORS exactly -- the same "Mirrors
// bearings/X.py's Y exactly" convention MapView.tsx already uses for
// NYC_BBOX/WALK_SPEED_MPS (small, static, geographic constants this app
// duplicates client-side rather than round-tripping through an API call).
// These 4 points never vary per cell (they're the same 4 named
// destinations for every address in the city), so baking them into the
// per-cell API contract instead -- the alternative -- would be real,
// avoidable payload duplication across ~7,000 baked cells for data that
// never changes; see this project's Wave 3 report for why a static mirror
// was chosen over a backend/contract change here.
//
// Used for the getting-around region's zone preview (SPEC-layout-v3.md
// §5.3): a default anchor bar has no `lat`/`lng` of its own anywhere in
// CellProfile (only its precomputed `to_anchors[name]` minute value), so
// this is the one place that fact has to live for the preview ring to be
// drawable at all.
export const ANCHOR_COORDS: Record<keyof ToAnchors, { lat: number; lng: number }> = {
  midtown: { lat: 40.7549, lng: -73.984 }, // Times Sq-42 St
  wtc: { lat: 40.7126, lng: -74.0099 }, // World Trade Center
  downtown_brooklyn: { lat: 40.6924, lng: -73.9875 }, // Jay St-MetroTech
  newport_path: { lat: 40.7267, lng: -74.0339 }, // Newport PATH, Jersey City
};
