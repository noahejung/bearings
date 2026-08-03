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

// LAYOUT-V3 WAVE 1d item 12 (2026-08-03, SPEC-layout-v3.md §8, Noah:
// "navigable or trimmed" for the slice of New Jersey inside NYC_BBOX --
// "default: trim/dim"). config.NYC_BBOX's west edge (-74.30) reaches past
// the Hudson into Bergen/Hudson County, NJ, because the citywide per-cell
// bake (cellprofile.py) is real-NYC-building-footprint-derived and NYC-only
// -- panning/zooming toward the Hudson today shows real basemap streets
// with nothing behind them (no citywide grid, no report data), inviting a
// dead-feeling area. This is a real, hand-plotted approximation of "west of
// the Hudson / Kill van Kull / Arthur Kill within NYC_BBOX" (public
// landmark coordinates -- GW Bridge, the Hudson waterfront, Kill van Kull,
// Raritan Bay -- not a precise administrative boundary), used ONLY to
// dim the basemap's own terrain/roads there, never to hide anything a real
// search/click draws on top of it (this layer sits BELOW the buildings/
// streets/citywide-grid/reach-ring overlay in buildOverlayLayers()'s own
// paint order, so a genuine local overlay drawn over this area -- e.g. the
// Newport, NJ PATH anchor's own neighbourhood, if a search ever resolves
// there -- still renders at full contrast on top of the dim). Reversible:
// deleting this one source/layer pair restores the plain basemap.
const NJ_MASK_POLYGON: [number, number][] = [
  [-74.30, 40.93], // NW corner of NYC_BBOX
  [-74.30, 40.47], // SW corner
  [-74.25, 40.47], // south edge, to where the boundary line starts
  [-74.23, 40.5],
  [-74.13, 40.6], // Kill van Kull / north shore of Staten Island
  [-74.05, 40.66], // Upper Bay / Bayonne
  [-74.02, 40.71], // Jersey City waterfront, opposite Lower Manhattan
  [-74.0, 40.75], // Hoboken waterfront, opposite Midtown
  [-73.96, 40.8], // opposite Upper Manhattan
  [-73.95, 40.85], // George Washington Bridge landing
  [-73.93, 40.87], // Riverdale/Yonkers latitude
  [-73.9, 40.93], // boundary line reaches the north edge of NYC_BBOX
  [-74.3, 40.93], // close back to the NW corner
];

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
      // Static, baked into the style itself (no fetch, never updates) --
      // see NJ_MASK_POLYGON's own comment for what this is and why.
      "nj-mask": {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [NJ_MASK_POLYGON] },
        },
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
      {
        // LAYOUT-V3 WAVE 1d item 12 -- painted last among the base style's
        // own layers (topmost of earth/water/roads, still below every
        // per-address local overlay MapView.tsx appends afterward via
        // `map.addLayer()`). A flat BONE wash, not a fifth colour -- reads
        // as "receded/out of scope," never a fabricated absence (the real
        // basemap streets/water underneath are still faintly visible
        // through it, honestly showing there IS land there, just not this
        // app's covered area).
        id: "nj-mask-fill",
        type: "fill",
        source: "nj-mask",
        paint: { "fill-color": BONE, "fill-opacity": 0.72 },
      },
    ],
  };
}

// MapView's own local overlay layers -- building mass, street hairlines,
// subway/PATH, the citywide click-to-load hit layer, and the reach-rings/
// dots feature -- extracted out of MapView.tsx (a pure, exported function
// rather than inline `map.addLayer()` calls) so this exact layer set is
// unit-testable with MapLibre's real style validator
// (`@maplibre/maplibre-gl-style-spec`'s `validateStyleMin`, the same
// function `map.addLayer` calls internally) without needing a live WebGL
// map. Order matters: MapLibre paints layers bottom-to-top in array order,
// so this array's order (building/street/subway mass under everything,
// reach rings/dots on top) must match the draw order MapView.tsx wants.
//
// FIXED 2026-07-15: two of these layers (streets-line's line-width/
// line-opacity) used to nest a `["zoom"]` expression inside `*`/`case`
// instead of using it as the direct top-level input to a `step`/
// `interpolate` -- a MapLibre style-spec violation that `map.addLayer`
// rejects SILENTLY (no thrown error, no console warning visible without
// opening devtools; the layer is simply never added), which is why this
// shipped and stayed broken through a normal API/console-exception smoke
// test. See mapStyle.test.ts for the regression test.
//
// RETIRED 2026-07-29 (SPEC-lens-report.md, "hex grid styling... too much
// visual clutter"): the local per-address metric-shaded H3 disk
// (cells-fill/cells-outline) and the crime-choropleth precinct layer
// (precinct-fill/precinct-outline, whose only UI trigger -- the "Shade the
// map by" dropdown -- was retired alongside it) are both deleted, not
// hidden. Every number they used to shade (noise/amenities/trees/
// building_age/transit_access/crime) is still fully visible in the
// per-cell report card below the map (CellReportView.tsx) -- no data was
// lost, only a redundant hex/choropleth map-shading affordance the spec
// explicitly asked to retire. See buildCitywideGridLayers()/
// buildReachLayers() below for what replaced them.
export function buildOverlayLayers(): StyleSpecification["layers"] {
  return [
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
    ...buildCitywideGridLayers(),
    ...buildReachLayers(),
    ...buildTileHighlightLayers(),
  ];
}

// The citywide clickable grid (SPEC-precompute-v2.md Phase 2). RETIRED
// 2026-07-29 (SPEC-lens-report.md, Noah: "i wanna move away from hex grid
// styling anyways, its too much visual clutter and doesnt make a lot of
// sense for the average user"): the visible faint grid line layer
// ("citywide-cells-outline") is deleted, not just hidden -- H3 stays the
// backend's own data/aggregation layer (untouched, see reach.py/mapgeo.py/
// cellprofile.py), it is simply never drawn on the map anymore. Only the
// already-transparent hit-test fill survives, because "click any real
// block to load its report" (SPEC-precompute-v2.md Phase 2) is existing
// report functionality this slice must keep working, just invisibly --
// MapLibre still dispatches mousemove/click events against a 0-opacity
// fill's real geometry, which is exactly why a fill (not the deleted
// outline) is what carries the click.
// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 3, Noah:
// "cursor: pointer... plus a visible hover state on the block under the
// cursor if not already present"). The hit-test fill itself is still
// transparent at rest (`0`) for the same reason as before (no visible grid
// -- SPEC-lens-report.md, "too much visual clutter"); MapView.tsx's own
// mousemove handler now writes a real per-feature `hover` boolean via
// `setFeatureState`, and this expression is the only thing that reads it --
// a real, felt "this block is interactive" signal that only appears under
// the cursor, never a permanent grid.
export function buildCitywideGridLayers(): StyleSpecification["layers"] {
  return [
    {
      id: "citywide-cells-fill",
      type: "fill",
      source: "citywide-cells",
      paint: {
        "fill-color": RED,
        "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.16, 0],
      },
    },
  ];
}

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4):
// what a hovered/expanded side-panel tile emphasizes on the map -- a
// polygon region (crime's precinct, or noise/trees/building's own cell)
// and/or a set of real named points (amenities' nearby places), fed by
// MapView.tsx's tileHighlightGeometry(). Both sources sit empty until a
// tile is actually active; painted LAST in buildOverlayLayers() (on top of
// the reach rings/dots) so the emphasis is never hidden underneath them.
// A bolder opacity than the bare hover fill above (0.16) -- this is a
// stronger, more deliberate signal ("the side panel is talking about
// THIS"), not a passive cursor hint.
export function buildTileHighlightLayers(): StyleSpecification["layers"] {
  return [
    {
      id: "tile-highlight-fill",
      type: "fill",
      source: "tile-highlight-region",
      paint: { "fill-color": RED, "fill-opacity": 0.26 },
    },
    {
      id: "tile-highlight-outline",
      type: "line",
      source: "tile-highlight-region",
      paint: { "line-color": RED, "line-width": 2, "line-opacity": 0.9 },
    },
    {
      id: "tile-highlight-points",
      type: "circle",
      source: "tile-highlight-points",
      paint: {
        "circle-radius": 6,
        "circle-color": RED,
        "circle-opacity": 0.92,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": INK,
      },
    },
  ];
}

// Reach rings (SPEC-lens-report.md §3): three 5/10/15-minute walk bands,
// straight-line circles (see bearings/reach.py's own module docstring for
// why -- no routable pedestrian graph exists in this codebase yet), plus
// one uniform-ink dot layer for chip-selected amenities/stations inside
// them. "Uniform ink" (not a per-category colour) is deliberate: VISUAL.md's
// four-token palette (bone/ink/steel/red) has no room for a 6th hue per
// category without breaking that rule -- MapView.tsx differentiates dots by
// content (name/category in a future hover), not colour.
//
// Draw order for the three nested bands is the GeoJSON FEATURE ARRAY order
// (MapView's reachRingsGeoJSON() emits largest-band-first), not a MapLibre
// z-index primitive -- a later feature in the same source/layer paints on
// top of an earlier one, so the smallest/darkest band always ends up
// visually "inside" the larger/fainter ones without needing three separate
// layers.
export function buildReachLayers(): StyleSpecification["layers"] {
  return [
    {
      id: "reach-rings-fill",
      type: "fill",
      source: "reach-rings",
      paint: {
        "fill-color": RED,
        "fill-opacity": ["match", ["get", "minutes"], 5, 0.26, 10, 0.17, 15, 0.1, 0.1],
      },
    },
    {
      id: "reach-rings-outline",
      type: "line",
      source: "reach-rings",
      paint: {
        "line-color": RED,
        "line-width": 1,
        "line-opacity": ["match", ["get", "minutes"], 5, 0.55, 10, 0.4, 15, 0.28, 0.28],
      },
    },
    {
      id: "reach-dots",
      type: "circle",
      source: "reach-dots",
      paint: {
        "circle-radius": 3.4,
        "circle-color": INK,
        "circle-opacity": 0.82,
        "circle-stroke-width": 1,
        "circle-stroke-color": BONE,
      },
    },
  ];
}
