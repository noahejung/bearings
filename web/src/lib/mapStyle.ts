import type { StyleSpecification } from "maplibre-gl";

// The tDR steel-set MapLibre style, authored ourselves (VISUAL.md §5,
// REVISED 2026-07-15): "we author the entire map style ourselves (land
// bone, water/parks steel, streets ink, labels in our grotesk), so the
// base is tDR, not someone else's look". Every colour here is one of the
// four locked tokens (web/src/styles/index.css's --bone/--ink/--steel/
// --red) -- no gradients, no third colour.
//
// Source-layer names (earth/water/landuse/roads) and their `kind` values
// are the real Protomaps Basemap v4 schema -- confirmed live 2026-07-15
// against docs.protomaps.com/basemaps/layers, not guessed. Deliberately
// NOT rendered from the basemap: `buildings` (this app draws its own real
// NYC building-footprint mass locally around the subject address --
// MapView's own overlay, sourced from NYC Open Data, not OSM) and `places`
// (city/neighbourhood name labels -- this app labels neighbourhoods from
// its own NTA data and precincts from its own NYPD data instead, both
// fetched via /api/citywide, so the map never shows two different label
// sets for the same idea). No `glyphs` key: nothing in this style uses a
// `symbol` layer with a `text-field` -- every text label on this map
// (subway routes, neighbourhood names, precinct numbers) is a real DOM
// element positioned with MapLibre's own screen-projection API
// (MapView.tsx), styled in this app's actual grotesk/mono fonts, not a
// pre-rendered glyph atlas that could only ever offer a generic sans.

const BONE = "#EDE9DE";
const INK = "#111111";
const STEEL = "#8A8D8F";
const RED = "#D7263D";

// Real Protomaps Basemap `landuse` `kind` values that read as green/open
// space -- steel, not a fifth colour, per VISUAL.md §2's "no colour
// outside the four".
const OPEN_SPACE_KINDS = [
  "park",
  "forest",
  "wood",
  "scrub",
  "grass",
  "meadow",
  "garden",
  "nature_reserve",
  "national_park",
  "protected_area",
  "cemetery",
  "golf_course",
  "recreation_ground",
  "zoo",
  "farmland",
  "farmyard",
  "orchard",
];

export function buildMapStyle(tilesUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "bearings — tDR steel",
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${tilesUrl}`,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": BONE } },
      {
        id: "earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": BONE },
      },
      {
        id: "open-space",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        filter: ["in", ["get", "kind"], ["literal", OPEN_SPACE_KINDS]],
        paint: { "fill-color": STEEL, "fill-opacity": 0.22 },
      },
      {
        id: "water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": STEEL, "fill-opacity": 0.5 },
      },
      {
        // Level-of-detail by zoom (VISUAL.md §5, REVISED 2026-07-15):
        // "Zoomed out (city): arterials ... Minor streets ... hidden.
        // Zooming in: residential streets fade in." `minzoom` drops minor
        // roads from the tile request entirely below city scale (not just
        // low opacity -- a real LOD cut, the same mechanism every slippy
        // map uses); the opacity ramp then fades them in over the next two
        // zoom levels rather than popping in at full strength.
        id: "roads-minor",
        type: "line",
        source: "basemap",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["minor_road", "path", "rail"]]],
        minzoom: 12,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": INK,
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 13.5, 0.32],
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.2, 16, 1],
        },
      },
      {
        // Arterials/highways stay visible at every zoom this map allows
        // (VISUAL.md: "Zoomed out (city): arterials ... visible") -- no
        // minzoom cut, only the existing width ramp.
        id: "roads-major",
        type: "line",
        source: "basemap",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["major_road", "highway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": INK,
          "line-opacity": 0.72,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 16, 2.4],
        },
      },
    ],
  };
}

// MapView's own local overlay layers -- building mass, street hairlines,
// subway/PATH, the crime-choropleth precinct layer, and the H3 metric
// disk -- extracted out of MapView.tsx (a pure, exported function rather
// than inline `map.addLayer()` calls) so this exact layer set is
// unit-testable with MapLibre's real style validator
// (`@maplibre/maplibre-gl-style-spec`'s `validateStyleMin`, the same
// function `map.addLayer` calls internally) without needing a live WebGL
// map. Order matters: MapLibre paints layers bottom-to-top in array
// order, so this array's order (precinct choropleth under everything,
// H3 cell disk on top) must match the draw order MapView.tsx wants.
//
// FIXED 2026-07-15: four of these seven layers (streets-line x2,
// cells-fill, cells-outline) used to nest a `["zoom"]` expression inside
// `*`/`case` instead of using it as the direct top-level input to a
// `step`/`interpolate` -- a MapLibre style-spec violation that
// `map.addLayer` rejects SILENTLY (no thrown error, no console warning
// visible without opening devtools; the layer is simply never added),
// which is why this shipped and stayed broken through a normal
// API/console-exception smoke test. See mapStyle.test.ts for the
// regression test.
export function buildOverlayLayers(): StyleSpecification["layers"] {
  // Subject cell always visible (VISUAL.md: "Subject cell always
  // visible") -- every other cell fades in from zoom 12 to 14, which is
  // also when the hex grid becomes "large enough to read". Plain numbers,
  // not a reusable `["interpolate", ..., ["zoom"], ...]` array, because a
  // `["zoom"]` expression must be the *direct* top-level value of a paint
  // property -- it cannot be nested inside `*`/`case`/etc. (that nesting
  // is exactly what silently dropped cells-fill/cells-outline before this
  // fix). cells-fill and cells-outline below instead fold this fade
  // window and their data-driven `case`/`match` logic into one single
  // top-level `interpolate` on `zoom`, matching values at each stop.
  const CELL_FADE_MIN_ZOOM = 12;
  const CELL_FADE_MAX_ZOOM = 14;

  return [
    {
      id: "precinct-fill",
      type: "fill",
      source: "precincts",
      layout: { visibility: "none" },
      paint: {
        "fill-color": RED,
        "fill-opacity": [
          "case",
          ["==", ["get", "hasCrime"], 0],
          0,
          ["interpolate", ["linear"], ["get", "w"], 0, 0.08, 1, 0.6],
        ],
      },
    },
    {
      id: "precinct-outline",
      type: "line",
      source: "precincts",
      layout: { visibility: "none" },
      paint: { "line-color": INK, "line-width": 0.6, "line-opacity": 0.5 },
    },
    {
      // Level-of-detail by zoom (VISUAL.md §5, REVISED 2026-07-15), the
      // same idea the basemap's own roads-minor/roads-major apply above:
      // building mass only makes visual sense once you're zoomed in
      // enough to read individual shapes.
      id: "buildings-fill",
      type: "fill",
      source: "buildings",
      paint: {
        "fill-color": STEEL,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 0.34],
      },
    },
    {
      id: "streets-line",
      type: "line",
      source: "streets",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": INK,
        // Top-level zoom interpolate whose two stop OUTPUTS carry the
        // rank-based `match` (a rank's width at zoom 13 vs 17 is just
        // that rank's base width times 0.7 or 1.4) -- linear
        // interpolation between those two per-feature outputs reproduces
        // the same width curve a `["*", <rank match>, <zoom interpolate>]`
        // would have, for every rank, without nesting `["zoom"]`.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13,
          ["*", ["match", ["get", "rank"], 0, 0.6, 1, 0.9, 2, 1.4, 3, 2.0, 0.6], 0.7],
          17,
          ["*", ["match", ["get", "rank"], 0, 0.6, 1, 0.9, 2, 1.4, 3, 2.0, 0.6], 1.4],
        ],
        // Residential (rank 0) streets fade in over zoom 13-15; every
        // higher rank keeps its previous fixed opacity (already visible
        // at any zoom this local overlay ever renders at). Same
        // restructuring as line-width: the rank `case`/`match` moves into
        // the two zoom stops' outputs, so a non-zero rank gets the
        // identical opacity value at both stops and stays flat across the
        // whole range.
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13,
          ["case", ["==", ["get", "rank"], 0], 0, ["match", ["get", "rank"], 1, 0.55, 2, 0.75, 3, 0.9, 0.35]],
          15,
          ["case", ["==", ["get", "rank"], 0], 0.35, ["match", ["get", "rank"], 1, 0.55, 2, 0.75, 3, 0.9, 0.35]],
        ],
      },
    },
    {
      id: "subway-line",
      type: "line",
      source: "subway",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": RED, "line-width": 2.4, "line-opacity": 0.92 },
    },
    {
      // The H3 disk is the only STRONG ink on the sheet (VISUAL.md §5) --
      // thin outline, subject cell red. Fill only carries a value when a
      // cell-resolution metric is selected -- `hasValue`/`w` are computed
      // once per metric selection in MapView's cellsGeoJSON(), so this
      // paint expression stays static regardless of which metric is
      // active.
      id: "cells-fill",
      type: "fill",
      source: "cells",
      paint: {
        "fill-color": RED,
        // Top-level zoom interpolate (12 -> 14, the CELL_FADE window)
        // whose stop outputs carry the isSubject/hasValue `case` and the
        // `w`-percentile `interpolate`. At zoom 12 the output is a flat 0
        // for every feature; at zoom 14 it's the real per-feature value.
        // Linear interpolation between "0" and "real value" over the same
        // 12->14 window is mathematically identical to a
        // `fade(zoom) * realValue` where fade is linear 0->1 across that
        // exact range.
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          CELL_FADE_MIN_ZOOM,
          0,
          CELL_FADE_MAX_ZOOM,
          [
            "case",
            ["==", ["get", "isSubject"], 1],
            0,
            ["==", ["get", "hasValue"], 1],
            ["interpolate", ["linear"], ["get", "w"], 0, 0.08, 1, 0.6],
            0,
          ],
        ],
      },
    },
    {
      id: "cells-outline",
      type: "line",
      source: "cells",
      paint: {
        "line-color": ["case", ["==", ["get", "isSubject"], 1], RED, INK],
        "line-width": ["case", ["==", ["get", "isSubject"], 1], 1.6, 0.6],
        // Same restructuring: the subject cell gets 1 at both zoom stops
        // (so it stays flat at "always visible" across the whole range --
        // interpolate clamps to the nearest stop past its ends), every
        // other cell fades 0 -> 0.45 across 12-14.
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          CELL_FADE_MIN_ZOOM,
          ["case", ["==", ["get", "isSubject"], 1], 1, 0],
          CELL_FADE_MAX_ZOOM,
          ["case", ["==", ["get", "isSubject"], 1], 1, 0.45],
        ],
      },
    },
  ];
}
