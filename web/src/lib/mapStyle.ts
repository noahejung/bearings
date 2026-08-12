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

// MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3, "zone-
// preview fades/scales in (~200ms) and out faster"). Exported (not a
// private literal) so MapView.tsx's effect 10c reads the exact same number
// when it hand-sets each destination-preview layer's `-transition` duration
// per direction (see that effect's own comment for why this can't be a
// single static config) -- one shared source, never a second independently-
// guessed literal. Mirrors lib/motion.ts's MOTION_BASE_MS/MOTION_FAST_MS
// values -- kept as its own constant rather than importing those directly
// because this wave's map-specific asymmetric split (200/130) is tuned
// slightly differently from the DOM-side anchor-row split (200/150); see
// this wave's own report for that specific tuning call.
export const DESTINATION_ENTER_MS = 200;
export const DESTINATION_EXIT_MS = 130;

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
//
// LAYOUT-V3 WAVE 1f item 1 (2026-08-11, SPEC-layout-v3.md §8, Noah: "the
// gray out of new jersey covers the west of manhattan a bit, verify this").
// VERIFIED, not assumed: cross-checked every east-edge vertex below against
// real published shoreline longitudes (Battery Park -74.019, Chelsea Piers
// -74.008, Midtown/Javits -74.002, Riverside Park/UWS -73.98, Washington
// Heights/GWB Manhattan anchorage -73.94). The PRE-1f points were measurably
// wrong in the direction Noah reported, not just "maybe": "opposite Midtown"
// was -74.0 -- 0.002 deg (~170m) EAST of Midtown's own real shore (-74.002),
// i.e. inside Manhattan; "George Washington Bridge landing" was -73.95,
// closer to the bridge's MANHATTAN anchorage (-73.9425) than its NJ one
// (Fort Lee, -73.97) -- a ~2.3km miss in the same "wrong side of the river"
// direction as this project's own prior anchor-snap bug. Every east-edge
// point below is now re-plotted with a deliberate westward safety margin
// (0.015-0.03 deg, ~1.3-3km) from the real Manhattan/Bronx shore at that
// latitude -- biased to fade a little EXTRA river rather than risk ever
// touching real NYC land again. This is the one direction imprecision here
// is actually safe: buildOverlayLayers()'s "water-unmasked" layer (below)
// always repaints the real vector water shape on top of this mask, so the
// river itself never reads as faded regardless of how far into the channel
// this hand-plotted boundary reaches.
const NJ_MASK_POLYGON: [number, number][] = [
  [-74.30, 40.93], // NW corner of NYC_BBOX
  [-74.30, 40.47], // SW corner
  [-74.25, 40.47], // south edge, to where the boundary line starts
  [-74.23, 40.5],
  [-74.15, 40.6], // Kill van Kull / north shore of Staten Island
  [-74.08, 40.66], // Upper Bay / Bayonne
  [-74.035, 40.71], // Jersey City waterfront, opposite Lower Manhattan
  [-74.025, 40.75], // Hoboken/Weehawken waterfront, opposite Midtown
  [-73.995, 40.8], // Edgewater waterfront, opposite the Upper West Side
  [-73.975, 40.85], // Fort Lee waterfront, opposite the GW Bridge
  [-73.95, 40.87], // Alpine/Palisades, opposite Riverdale/Yonkers latitude
  [-73.93, 40.93], // boundary line reaches the north edge of NYC_BBOX
  [-74.3, 40.93], // close back to the NW corner
];

// WAVE 6f item 9 (2026-08-11, Noah: "hard-edged dark gray diagonal band
// sweeping Greenpoint -> Newtown Creek -> LIC"). ROOT-CAUSED live, not
// guessed -- REPRODUCED via Playwright (jumpTo this exact area, pitch 0,
// no interaction needed -- deterministic, not a transient rendering
// glitch: confirmed identical on a totally fresh page load with a single
// direct jumpTo, no intermediate zoom/pan history to blame), then
// layer-isolated one style layer at a time via `map.setLayoutProperty(id,
// "visibility", "none")`: every OTHER layer in this file (earth, open-
// space, roads-minor/major, nj-mask-fill, buildings-fill, streets-line,
// citywide-cells-fill, and every hover/highlight/destination layer in
// buildOverlayLayers() below) left the band fully intact when hidden --
// only hiding BOTH "water" AND "water-unmasked" together made it vanish
// completely (hiding either ALONE did not, because the other still
// painted the identical real geometry -- see "water-unmasked"'s own
// comment above for why this app intentionally has two layers reading the
// same source-layer). `map.queryRenderedFeatures()` at a point inside the
// visible band found no real "water" feature geometry there at all
// (point-in-ring testing against the TRUE tile coordinates correctly
// finds nothing), while the GPU still painted pixels there -- the
// signature of a genuinely malformed (self-intersecting/bowtie) ring in
// the underlying vector-tile polygon, mistriangulated by earcut into
// stray geometry that extends past the feature's own real boundary. This
// is real third-party tile data (Protomaps' daily planet build, byte-
// range-extracted verbatim by `pmtiles extract` in basemap.py -- see that
// module's own docstring: this app does not re-encode or re-tile
// anything), not a polygon authored anywhere in this codebase, so it
// cannot be fixed by correcting a ring's winding order here the way a
// hand-authored mask (NJ_MASK_POLYGON) could be -- this codebase controls
// zero of the vertices that are actually wrong. Following this file's own
// established precedent for a real, confirmed-live MapLibre/tile
// rendering defect that can't be fixed at the source (WAVE 6c item 1's
// maxPitch cap, this file's own comment above it): a small, honestly-
// documented, narrowly-scoped mitigation, not a guessed one. Verified
// live across zoom 11-15 and multiple pan positions (west/east/north/
// south) that this rectangle comfortably covers every screen position the
// defect ever painted, without being large enough to swallow unrelated,
// correctly-rendered water elsewhere (the Hudson, Jamaica Bay, the
// Rockaways are all far outside it).
const NEWTOWN_CREEK_BAD_ZONE: [number, number][] = [
  [-73.978, 40.705],
  [-73.915, 40.705],
  [-73.915, 40.755],
  [-73.978, 40.755],
  [-73.978, 40.705],
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

// Level-of-detail by zoom (VISUAL.md §5, REVISED 2026-07-15): "Zoomed out
// (city): arterials ... Minor streets ... hidden. Zooming in: residential
// streets fade in." `minzoom` drops minor roads from the tile request
// entirely below city scale (not just low opacity -- a real LOD cut, the
// same mechanism every slippy map uses); the opacity ramp then fades them
// in over the next two zoom levels rather than popping in at full
// strength. Factored out to a shared constant (WAVE 6f item 9, 2026-08-11)
// so it can be painted TWICE -- once at its original citywide position,
// once again as "roads-minor-repaint" after newtown-creek-mask-fill below
// -- without two independently-drifting copies of this same expression.
const ROADS_MINOR: NonNullable<StyleSpecification["layers"]>[number] = {
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
};

// Arterials/highways stay visible at every zoom this map allows (VISUAL.md:
// "Zoomed out (city): arterials ... visible") -- no minzoom cut, only the
// existing width ramp. Factored out for the same reason as ROADS_MINOR
// above.
const ROADS_MAJOR: NonNullable<StyleSpecification["layers"]>[number] = {
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
};

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
      // WAVE 6f item 9 -- see NEWTOWN_CREEK_BAD_ZONE's own comment above.
      "newtown-creek-mask": {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [NEWTOWN_CREEK_BAD_ZONE] },
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
      ROADS_MINOR,
      ROADS_MAJOR,
      {
        // LAYOUT-V3 WAVE 1d item 12 -- painted after earth/open-space/roads
        // (topmost of the base style's own layers so far), still below
        // every per-address local overlay MapView.tsx appends afterward via
        // `map.addLayer()`. A flat BONE wash, not a fifth colour -- reads
        // as "receded/out of scope," never a fabricated absence (the real
        // basemap streets/water underneath are still faintly visible
        // through it, honestly showing there IS land there, just not this
        // app's covered area). Sitting above roads-major/roads-minor is
        // what satisfies SPEC-layout-v3.md §8 Wave 1f item 1's "no road
        // rendering in the faded area" -- both road layers paint BEFORE
        // this one, so this wash covers them within the polygon.
        id: "nj-mask-fill",
        type: "fill",
        source: "nj-mask",
        paint: { "fill-color": BONE, "fill-opacity": 0.72 },
      },
      {
        // LAYOUT-V3 WAVE 1f item 1 (2026-08-11, SPEC-layout-v3.md §8, Noah:
        // "the river stays unfaded; only the NJ land fades"). A real
        // structural conflict, not solvable by coordinate-tuning alone:
        // nj-mask-fill must paint ABOVE roads (to hide them, the requirement
        // above) but must NOT visually cover the Hudson/bay water -- and
        // "water" (above) already has to paint BEFORE roads elsewhere in
        // this array so roads read on top of water citywide. The one clean
        // fix that doesn't reorder any OTHER layer: repaint the exact same
        // real vector "water" source-layer a second time, here, on top of
        // the mask. Wherever NJ_MASK_POLYGON's hand-plotted boundary is
        // imprecise (inevitable -- it's a dozen straight segments
        // approximating a real, curved shoreline), the ACTUAL water
        // geometry from the basemap always wins the last paint, so the
        // river reads correctly regardless of exactly where the polygon
        // edge falls within the channel. Purely additive (same source,
        // source-layer, and paint as "water" above) -- deleting this one
        // layer alone reverts to the pre-1f "mask can cover water" behavior
        // with zero other changes.
        id: "water-unmasked",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": STEEL, "fill-opacity": 0.5 },
      },
      {
        // WAVE 6f item 9 -- see NEWTOWN_CREEK_BAD_ZONE's own comment above
        // for the full live diagnosis. Painted directly above BOTH "water"
        // and "water-unmasked" (the two layers confirmed live to jointly
        // paint the malformed geometry) -- a flat, fully OPAQUE BONE wash
        // cancels whatever those two just painted within this one hand-
        // verified rectangle, the same "recede to the base colour"
        // technique nj-mask-fill above already uses for out-of-scope New
        // Jersey. Fully opaque (not nj-mask-fill's 0.72) deliberately --
        // this has to WIN completely against a real, confirmed rendering
        // bug, not just visually recede; a translucent cancel would still
        // show the malformed shape bleeding through underneath it.
        //
        // Being fully opaque means this ALSO erases roads-minor/
        // roads-major (both painted earlier, above) and the real,
        // correctly-shaped part of Newtown Creek, wherever any of them
        // fall inside this rectangle -- an honest, fully-repainted cost,
        // not a hidden one: "roads-minor-repaint"/"roads-major-repaint"
        // immediately below restore the real streets (identical paint,
        // repainted on top of this cancel -- imperceptible where they
        // already matched, since it's the exact same geometry drawn
        // again), and "newtown-creek-line" after that repaints the
        // creek's real centreline path, so nothing this map already
        // promised to show (streets, the waterway itself) silently
        // disappears within this one zone.
        id: "newtown-creek-mask-fill",
        type: "fill",
        source: "newtown-creek-mask",
        paint: { "fill-color": BONE, "fill-opacity": 1 },
      },
      // WAVE 6f item 9 -- see newtown-creek-mask-fill's own comment just
      // above for why these two are repainted here: that cancel fill is
      // fully opaque and sits above roads-minor/roads-major (both painted
      // near the top of this file, before nj-mask-fill), so without this
      // repaint, real Greenpoint/LIC streets would vanish inside
      // NEWTOWN_CREEK_BAD_ZONE -- a worse regression than the bug this
      // wave set out to fix. Reuses the exact same ROADS_MINOR/ROADS_MAJOR
      // constants (defined once, above buildMapStyle()) with a new `id`
      // (MapLibre layer ids must be unique) -- never a second,
      // independently-drifting copy of either expression.
      { ...ROADS_MINOR, id: "roads-minor-repaint" },
      { ...ROADS_MAJOR, id: "roads-major-repaint" },
      {
        // WAVE 6f item 9 -- the honest fallback promised above:
        // "newtown-creek-mask-fill" erases both the real and the
        // malformed water fill within NEWTOWN_CREEK_BAD_ZONE, so this
        // layer repaints the creek's real path from a source unaffected
        // by the polygon bug -- the SAME "water" source-layer's own
        // `kind: "river"/"stream"` and `kind: "strait"` features (real,
        // named LineStrings -- "Newtown Creek", "West Channel", "East
        // Channel", confirmed live via `querySourceFeatures()` during this
        // wave's own diagnosis), which a `fill` layer never renders
        // (LineString geometry is silently skipped by fill layers) and so
        // were never part of the bug -- only the `kind: "water"`/`"ocean"`
        // POLYGON features were. A real river/stream centreline, not a
        // guessed or hand-plotted shape. Painted last (topmost) so it's
        // never hidden under the road repaint above.
        id: "newtown-creek-line",
        type: "line",
        source: "basemap",
        "source-layer": "water",
        filter: ["in", ["get", "kind"], ["literal", ["river", "stream", "strait"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": STEEL, "line-width": 2, "line-opacity": 0.8 },
      },
    ],
  };
}

// MapView's own local overlay layers -- building mass, street hairlines,
// subway/PATH, the citywide click-to-load hit layer, and the reach-dots
// feature -- extracted out of MapView.tsx (a pure, exported function
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
// LAYOUT-V3 WAVE 1e (2026-08-03, SPEC-layout-v3.md §8): a real building is
// "residential" (clickable for its own year/hazard record) only when its
// own PLUTO landuse code says so -- `null` (no PLUTO/HPD match at all, or a
// footprint with no bbl) is treated the same as `false` here: a building
// this codebase has no record for gets no interactive affordance, never a
// guessed one. `["coalesce", ["get", "residential"], false]`/`["coalesce",
// ["get", "hazard_class_c"], 0]` (below, inlined at each real call site
// rather than a shared constant -- this file's own style-spec types don't
// structurally accept a widened array type extracted out of its literal
// expression context, so every other filter/expression here is written
// fresh at its own call site too) guard against a literal `null` property
// value, which MapLibre's own `==`/`>` operators otherwise reject outright.

export function buildOverlayLayers(): StyleSpecification["layers"] {
  return [
    {
      // Level-of-detail by zoom (VISUAL.md §5, REVISED 2026-07-15), the
      // same idea the basemap's own roads-minor/roads-major apply above:
      // building mass only makes visual sense once you're zoomed in
      // enough to read individual shapes.
      //
      // LAYOUT-V3 WAVE 1e: a residential building (real PLUTO landuse
      // match) reads at the original ~34% opacity VISUAL.md's own "Buildings
      // | Steel #8A8D8F mass at ~34% opacity" spec names; a non-residential
      // or unknown-record building is dimmed to a lower opacity -- still
      // pure STEEL (no new hue, no gradient -- an opacity `case` nested
      // inside the existing zoom `interpolate`, the identical pattern this
      // file's roads-minor/streets-line layers already use), a real, felt
      // "these buildings respond, those don't" signal at rest, before any
      // hover ever happens (SPEC-layout-v3.md §8 Wave 1e acceptance: "non-
      // residential buildings clearly distinguishable").
      id: "buildings-fill",
      type: "fill",
      source: "buildings",
      paint: {
        "fill-color": STEEL,
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          13,
          0,
          15,
          ["case", ["==", ["coalesce", ["get", "residential"], false], true], 0.34, 0.2],
        ],
      },
    },
    {
      // A persistent (not hover-gated) signal for a residential building
      // with at least one real open Class C ("immediately hazardous") HPD
      // violation -- lets a user see which buildings on a block carry a
      // real flag without having to click every one, the same "felt, not
      // just clickable" bar the tile grid's own `tile__value--flag` (red
      // text) already sets for the exact same fact. Red is this app's one
      // accent colour (VISUAL.md §2: "Pillar-box red... Accent only"),
      // already used for exactly this kind of flag.
      id: "buildings-hazard-outline",
      type: "line",
      source: "buildings",
      filter: [
        "all",
        ["==", ["coalesce", ["get", "residential"], false], true],
        [">", ["coalesce", ["get", "hazard_class_c"], 0], 0],
      ],
      paint: { "line-color": RED, "line-width": 1.1, "line-opacity": 0.55 },
    },
    {
      // The click/hover hit layer for the per-building info panel
      // (MapView.tsx's own building-click handling) -- filtered to
      // residential buildings only, so a non-residential building never
      // shows a hover highlight or opens a popup (the "exclude" half of
      // SPEC-layout-v3.md §8 Wave 1e's "clearly distinguishable or
      // excluded" acceptance). Invisible at rest (0 opacity, same
      // established pattern as citywide-cells-fill below), a stronger red
      // than that layer's own 0.16 block-hover fill on real hover
      // (feature-state-driven, mirrors citywide-cells-fill's own
      // mousemove-driven hover exactly) -- deliberately painted on top of
      // it in this array (buildings sit visually "inside" a block, so
      // their own hover reads as a more specific, stronger signal).
      id: "buildings-residential-hover",
      type: "fill",
      source: "buildings",
      filter: ["==", ["coalesce", ["get", "residential"], false], true],
      paint: {
        "fill-color": RED,
        // MOTION WAVE (2026-08-03, item 3, "building hover-highlight ease
        // opacity rather than snapping") -- set via
        // `map.setPaintProperty("buildings-residential-hover",
        // "fill-opacity-transition", ...)` in MapView.tsx's effect 2, not
        // inline here -- see citywide-cells-fill's own comment above for
        // why. Same textbook feature-state-transition case (the SAME
        // building footprint persists continuously; only its hover feature-
        // state toggles), so this genuinely animates, unlike a source that
        // goes empty<->populated.
        "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.3, 0],
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
    // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the route-line
    // preview -- the real GTFS shape(s) a computed commute actually rode,
    // drawn OVER the always-on "subway-line" backdrop above. No new colour
    // (VISUAL.md's four-colour rule): distinct from that backdrop by width
    // alone (5px vs 2.4px, full opacity vs 0.92) -- thick enough to read as
    // "this is the one that matters" against the thin citywide wash, never
    // competing with RouteBullet's own carved-out MTA-colour exception
    // (that colours the bullet glyphs, not this line). Distinct from the
    // destination zone preview too (a filled polygon, not a line) --
    // MapView.tsx's own effect 10c never shows both for the same
    // destination at once (see that effect's own comment).
    {
      id: "route-line-highlight",
      type: "line",
      source: "route-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": RED, "line-width": 5, "line-opacity": 1 },
    },
    ...buildCitywideGridLayers(),
    ...buildReachLayers(),
    ...buildTileHighlightLayers(),
    ...buildDestinationPreviewLayers(),
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
        // MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3):
        // this hover fill now animates -- see MapView.tsx's effect 2, where
        // `map.setPaintProperty("citywide-cells-fill", "fill-opacity-
        // transition", ...)` sets the GPU-side transition config for this
        // property. NOT set inline here as a `"fill-opacity-transition"` key
        // on this paint object: this installed version of
        // @maplibre/maplibre-gl-style-spec's TS types model `-transition`
        // ONLY as a single style-wide `StyleSpecification.transition`
        // default, not as a per-property sibling key on a static layer's
        // `paint` object -- confirmed by reading that package's own
        // index.d.ts before assuming the inline form would even compile.
        // `Map.setPaintProperty()`'s signature (`name: string, value: any`)
        // has no such restriction, which is why it's set there instead. This
        // IS the exact textbook use case for the mechanism either way: the
        // SAME feature persists continuously (a real citywide cell polygon,
        // never removed/re-added), only its evaluated `feature-state` hover
        // value changes -- MapLibre's own official "Create a hover effect"
        // example uses this identical property.
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
// MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3): "tile-
// highlight region... ease opacity rather than snapping." `visible` is
// MapView.tsx's withFadeFallback() flag -- gates the real opacity to 0
// while a source is holding the LAST tile's now-stale region/points
// (re-emitted, not emptied, specifically so this property change is a
// persisting-feature opacity change a transition CAN animate -- see that
// function's own comment). The actual GPU-side transition config for all
// three layers below is set via `map.setPaintProperty(..., "<prop>-
// transition", { duration: 200 })` in MapView.tsx's effect 2, not inline
// here -- see citywide-cells-fill's own comment (above, this file) for why
// an inline `-transition` key doesn't type-check against this installed
// version of @maplibre/maplibre-gl-style-spec's paint object types.
export function buildTileHighlightLayers(): StyleSpecification["layers"] {
  return [
    {
      id: "tile-highlight-fill",
      type: "fill",
      source: "tile-highlight-region",
      paint: {
        "fill-color": RED,
        "fill-opacity": ["case", ["boolean", ["get", "visible"], true], 0.26, 0],
      },
    },
    {
      id: "tile-highlight-outline",
      type: "line",
      source: "tile-highlight-region",
      paint: {
        "line-color": RED,
        "line-width": 2,
        "line-opacity": ["case", ["boolean", ["get", "visible"], true], 0.9, 0],
      },
    },
    {
      id: "tile-highlight-points",
      type: "circle",
      source: "tile-highlight-points",
      paint: {
        "circle-radius": 6,
        "circle-color": RED,
        "circle-opacity": ["case", ["boolean", ["get", "visible"], true], 0.92, 0],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": INK,
      },
    },
  ];
}

// Chip-selected amenity/station dots (SPEC-lens-report.md §3) -- one
// uniform-ink dot layer for real named places/stations inside the searched
// address's own 5/10/15-minute walk bands. "Uniform ink" (not a per-category
// colour) is deliberate: VISUAL.md's four-token palette (bone/ink/steel/red)
// has no room for a 6th hue per category without breaking that rule --
// MapView.tsx differentiates dots by content (name/category in a future
// hover), not colour.
//
// LAYOUT-V3 WAVE 6c item 6 (2026-08-11, Noah: "the 5/10/15-minute walk rings
// around searched addresses aren't helpful either"). The three nested ring
// bands this function used to also draw ("reach-rings-fill"/"reach-rings-
// outline", RED fills/outlines over a "reach-rings" source) are deleted
// outright, not hidden -- MapView.tsx no longer populates any "reach-rings"
// source at all (see that file's own item 6 comment for the full removal +
// what was verified before deleting). This dot layer is the one part of the
// original reach-rings feature set that survives: the underlying places/
// stations are still real, still band-tagged, still worth showing on the
// map once a category chip is turned on -- only the abstract distance-band
// polygon itself was judged unhelpful.
export function buildReachLayers(): StyleSpecification["layers"] {
  return [
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

// LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.3 "Zone preview"): hovering or
// selecting any getting-around bar (one of the 4 baked ANCHORS, or a
// custom destination) draws straight-line 5/10/15-minute walk rings around
// the DESTINATION, via its own dedicated source/layer set, fully
// independent of the searched-address rings this same technique used to
// also draw around the ADDRESS (removed in Wave 6c item 6 -- see
// buildReachLayers()'s own comment; this function was never the thing that
// drew those, so removing them left this one untouched). Painted LAST (see
// buildOverlayLayers() above) -- topmost, since this is the most immediate
// thing the user is currently pointing at.
// UX-FIX 2026-08-03 (audit finding #3, "layered map highlights compound
// into an illegible wall of red") -- HIGHLIGHT PRIORITY RULE, applied here.
// Every ring/point feature carries a real `dimmed` boolean (see MapView.tsx's
// destinationRingsGeoJSON()/destinationPointGeoJSON(), set by that file's own
// effect 10c comment for the full rule). `["case", ["get","dimmed"], <faint
// flat value>, <existing per-band value>]` wraps every opacity below: a
// SELECTED destination never goes fully invisible when a tile hover takes
// priority (Wave 3's own "never silently absent" rule for a pinned place),
// it just recedes well below the newer, more specific tile highlight instead
// of visually fighting it for the same red ink.
//
// MOTION WAVE (2026-08-03, item 3, "zone-preview fades/scales in (~200ms)
// and out faster; ... the highlight-priority dimmed state transitions
// smoothly instead of jumping"). Every paint value below is now wrapped in
// an OUTER `["case", ["boolean", ["get","visible"], true], <the dimmed-
// aware expression above>, 0]` -- `visible` is the fade-rather-than-pop
// flag MapView.tsx's withFadeFallback() sets (see that function's own
// comment: it re-emits the last real ring/point geometry at `visible:false`
// instead of collapsing the source to nothing). The actual GPU-side
// transition config for these three layers is set via
// `map.setPaintProperty(..., "<prop>-transition", { duration })` in
// MapView.tsx's effect 10c -- NOT inline here (see citywide-cells-fill's
// own comment for why an inline `-transition` key doesn't type-check) --
// and set PER DIRECTION there (DESTINATION_ENTER_MS entering,
// DESTINATION_EXIT_MS exiting, both exported from this file), which is also
// why it has to be a runtime call rather than a single static value: this
// wave's own "fades... in and out faster" asymmetry has no single number
// that would satisfy both directions. `circle-radius` also gates on
// `visible` (5 -> 0) for a real "scale in/out" on the destination's own
// point -- deliberately NOT applied to the rings themselves: a ring's
// radius is real walking-distance geometry (5/10/15-minute bands), so
// animating IT would show a transiently WRONG (too-small) distance
// mid-transition, which this project's own rules forbid even as a
// decorative side effect. The point marker carries no distance claim, so
// scaling it is honest.
export function buildDestinationPreviewLayers(): StyleSpecification["layers"] {
  return [
    {
      id: "destination-rings-fill",
      type: "fill",
      source: "destination-rings",
      paint: {
        "fill-color": RED,
        "fill-opacity": [
          "case",
          ["boolean", ["get", "visible"], true],
          [
            "case",
            ["boolean", ["get", "dimmed"], false],
            0.05,
            ["match", ["get", "minutes"], 5, 0.26, 10, 0.17, 15, 0.1, 0.1],
          ],
          0,
        ],
      },
    },
    {
      id: "destination-rings-outline",
      type: "line",
      source: "destination-rings",
      paint: {
        "line-color": RED,
        "line-width": 1,
        "line-opacity": [
          "case",
          ["boolean", ["get", "visible"], true],
          [
            "case",
            ["boolean", ["get", "dimmed"], false],
            0.15,
            ["match", ["get", "minutes"], 5, 0.55, 10, 0.4, 15, 0.28, 0.28],
          ],
          0,
        ],
      },
    },
    {
      // The destination's own point -- without this, three faint concentric
      // rings with no visible centre reads ambiguously; a small solid dot
      // marks exactly where "there" is.
      id: "destination-point",
      type: "circle",
      source: "destination-point",
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "visible"], true], 5, 0],
        "circle-color": RED,
        "circle-opacity": [
          "case",
          ["boolean", ["get", "visible"], true],
          ["case", ["boolean", ["get", "dimmed"], false], 0.35, 0.92],
          0,
        ],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": INK,
      },
    },
  ];
}
