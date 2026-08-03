import * as h3 from "h3-js";
import type { Feature, FeatureCollection } from "geojson";
import maplibregl, { type LngLat, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getCellsIndex, getCitywide, getMapGeometry, getReach } from "../api";
import { buildMapStyle, buildOverlayLayers } from "../lib/mapStyle";
import type { PinnedPlace } from "../lib/preferences";
import type { CellsIndexEntry, Citywide, MapGeometry, Reach } from "../types";
import type { TileHighlightKey } from "./CellReportView";
import { colorFor } from "./RouteBullet";

// VISUAL.md §5, REVISED 2026-07-15 -- MapLibre GL reading a self-hosted
// Protomaps PMTiles extract of NYC (bearings/sources/basemap.py bakes it;
// api.py serves it from this app's own /tiles origin, never a third-party
// tile server at request time). The base map (mapStyle.ts) is authored to
// this app's own palette; everything on top of it is real geometry from
// GET /api/map (the neighbourhood around the searched address -- building
// mass, street hairlines, subway/PATH) and GET /api/citywide (address-
// independent: NTA neighbourhood labels and NYPD precinct centroids, for
// the label markers only -- see effect 5/7 below).
//
// SPEC-precompute-v2.md Phase 2 (2026-07-15): the map is no longer gated
// behind a loaded report. It mounts immediately with GET /api/cells (every
// real H3 res-9 cell citywide) as an invisible, always-on, CLICKABLE hit
// layer, independent of whether `address` is set. `address` drives the
// local building/street/subway overlay AND the reach-rings feature for
// whichever address was actually searched -- it can be `null` (a bare cell
// click has no address), in which case both are simply empty, never
// fetched, never blocking.
//
// RETIRED 2026-07-29 (SPEC-lens-report.md, Noah: "i wanna move away from
// hex grid styling anyways, its too much visual clutter and doesnt make a
// lot of sense for the average user"): the visible H3 grid, the local
// per-address metric-shaded disk, and the crime-choropleth precinct layer
// are all gone from the map. H3 stays the backend's own data/aggregation
// layer (untouched -- reach.py/mapgeo.py/cellprofile.py), it is simply
// never drawn here anymore; "click any block to load its report" survives
// via the already-transparent hit-test fill (see mapStyle.ts's own
// updated comment). Replacing them: reach rings + chip-selected amenity/
// station dots + pinned-place badges (SPEC-lens-report.md §2-4), and a
// two-entry lens-switcher stub ("minimal" is the only real lens this
// slice; a disabled second slot exists so slice 2's transit/green/3D-tilt
// lenses have somewhere to land).

// Mirrors bearings/config.py's NYC_BBOX -- used ONLY to frame the initial
// view so the whole city is visible on first paint. This is NOT how "real
// cell" is decided (that stays the backend's data-derived job, see
// cellprofile.py's own module docstring) -- it is purely a camera bound.
const NYC_BBOX = { south: 40.47, north: 40.93, west: -74.30, east: -73.70 };

const INK = "#111111";
const RED = "#D7263D";
const STEEL = "#8A8D8F";

// Mirrors bearings/transit.py's WALK_SPEED_MPS -- the same "Mirrors ..."
// duplication pattern NYC_BBOX above already uses. Only ever used here for
// a single scalar (a pinned place's own walk-time badge), never a rendered
// geometry -- reach.py computes and returns the actual ring polygons
// server-side (see reachRingsGeoJSON() below), so the one real duplication
// risk (the ring SHAPE itself drifting from the backend) doesn't exist;
// only the badge's minute count could ever disagree, and by how the two
// are computed identically it won't.
const WALK_SPEED_MPS = 1.35;

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000.0;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// GeoJSON builders -- pure functions from the API contract to what MapLibre
// wants. GeoJSON is always [lng, lat]; every upstream field here (h3-js
// boundaries, MapGeometry coords, reach.py's ring polygons) is [lat, lng]
// like the rest of this codebase, so every builder below flips it once,
// here, rather than leaving that inversion to be rediscovered per-consumer.
// ---------------------------------------------------------------------------

// The citywide clickable grid (SPEC-precompute-v2.md Phase 2) -- every real
// cell from GET /api/cells, as one GeoJSON polygon per cell, carrying only
// its own h3 id (the click handler reads `properties.h3`). Deliberately no
// numeric `id`/feature-state anymore (RETIRED 2026-07-29): the only reason
// citywideCellsGeoJSON() used to assign one was to drive the now-deleted
// visible outline's "selected" emphasis (MapLibre's setFeatureState only
// renders for a numeric GeoJSON feature id, confirmed live 2026-07-15) --
// with that outline gone, plain hit-testing needs no id at all.
// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 3): each
// feature now also carries a numeric top-level `id` (index into `entries`,
// stable within one citywide-grid fetch) -- MapLibre's `setFeatureState`
// only works against a real numeric GeoJSON feature id, confirmed live
// 2026-07-15 (see this file's own top comment on the RETIRED selection
// outline, which needed the same thing for the same reason). This is the
// one piece of that retired mechanism this wave re-adds, for a new purpose:
// a real visible hover highlight (Noah, 2026-08-03: "a cursor pointer plus
// a visible hover state... if not already present" -- the cursor already
// existed, the visible state did not).
function citywideCellsGeoJSON(entries: CellsIndexEntry[]): FeatureCollection {
  const features: Feature[] = entries.map((c, i) => {
    const boundary = h3.cellToBoundary(c.h3) as [number, number][]; // [lat, lng]
    const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]); // close the polygon ring
    return {
      type: "Feature",
      id: i,
      properties: { h3: c.h3 },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });
  return { type: "FeatureCollection", features };
}

function buildingsGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.buildings.map((b) => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [b.coords.map(([lat, lng]): [number, number] => [lng, lat])],
      },
    })),
  };
}

function streetsGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.streets.map((s) => ({
      type: "Feature",
      properties: { rank: s.rank },
      geometry: {
        type: "LineString",
        coordinates: s.coords.map(([lat, lng]): [number, number] => [lng, lat]),
      },
    })),
  };
}

function subwayGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.subway_lines.map((line) => ({
      type: "Feature",
      properties: { route: line.route },
      geometry: {
        type: "LineString",
        coordinates: line.coords.map(([lat, lng]): [number, number] => [lng, lat]),
      },
    })),
  };
}

// Reach rings (SPEC-lens-report.md §3) -- one Feature per real 5/10/15-min
// band, ordered LARGEST FIRST: mapStyle.ts's buildReachLayers() draws a
// GeoJSON source's features in array order, so this ordering IS the "5-min
// band paints on top of 10, which paints on top of 15" nesting, not a
// z-index primitive. Sorted defensively rather than trusting the backend's
// own array order, since draw order is load-bearing here.
function reachRingsGeoJSON(reach: Reach): FeatureCollection {
  const ordered = [...reach.bands].sort((a, b) => b.minutes - a.minutes);
  return {
    type: "FeatureCollection",
    features: ordered.map((band) => ({
      type: "Feature",
      properties: { minutes: band.minutes },
      geometry: {
        type: "Polygon",
        coordinates: [band.polygon.map(([lat, lng]): [number, number] => [lng, lat])],
      },
    })),
  };
}

// Chip-selected amenity/station dots (SPEC-lens-report.md §2/§4) -- a pure
// CLIENT-SIDE filter of the already-fetched `reach.places`/`reach.stations`
// against `activeCategories`, never a new network round-trip on chip
// toggle (spec: "updates the map live without re-searching the address").
// `activeCategories` uses the exact same string keys reach.py's real
// Overture category buckets do (see lib/preferences.ts's REACH_CHIPS),
// plus the literal string "transit" for GTFS stations, which aren't an
// Overture category at all.
function reachDotsGeoJSON(reach: Reach, activeCategories: Set<string>): FeatureCollection {
  const features: Feature[] = [];
  for (const p of reach.places) {
    if (!activeCategories.has(p.category)) continue;
    features.push({
      type: "Feature",
      properties: { name: p.name, category: p.category, band_minutes: p.band_minutes },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    });
  }
  if (activeCategories.has("transit")) {
    for (const s of reach.stations) {
      features.push({
        type: "Feature",
        properties: { name: s.name, category: "transit", band_minutes: s.band_minutes },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4, Noah:
// "when these blocks note a place nearby, can it actually help highlight
// stuff, i.e. where the groceries [are], the ... regioning"). Two real,
// differently-sourced kinds of "what this tile is talking about" -- never a
// third, fabricated kind:
//   - "amenities" -> real named POINTS. The only client-side point data
//     for named places is `reach.places` (GET /api/reach), which is
//     fetched ONLY for a real searched address -- a bare grid click has no
//     address and therefore no `reach`, so this returns empty points for
//     that case (a real, reportable gap, not a fabricated pin). Even when
//     `reach` exists, its places are found within the 5/10/15-minute walk
//     rings around the searched point -- a DIFFERENT radius/method than
//     `cell.amenities.counts`' own one-cell tally (see CellReportView.tsx's
//     own top comment on why these two counts can legitimately disagree),
//     so these pins read as "real nearby places in the categories this
//     tile counts," not as "exactly the N places in the headline number."
//   - "crime"/"noise"/"trees"/"building" -> a real AREA. Crime is a
//     precinct-level percentile (bearings/citywide.py) attributed to this
//     block, so its honest region is the precinct's own real polygon
//     (already fetched once, address-independent, via GET /api/citywide,
//     for the precinct-label layer) -- looked up by the exact precinct
//     number this cell's own report carries. Noise/trees/building are each
//     counted over exactly ONE h3 cell (cellprofile.py: no ring, no
//     radius -- see CellReportView.tsx's own top comment), so their honest
//     region is that literal cell boundary, computed client-side from its
//     h3 id (the same h3-js call citywideCellsGeoJSON() already makes per
//     cell above) -- no extra fetch, no approximation beyond what the
//     number itself already represents.
function tileHighlightGeometry(
  tile: TileHighlightKey | null,
  ctx: {
    reach: Reach | null;
    citywide: Citywide | null;
    selectedCell: string | null;
    crimePrecinct: number | null;
  },
): { region: FeatureCollection; points: FeatureCollection } {
  if (tile === "amenities") {
    if (!ctx.reach) return { region: EMPTY_FC, points: EMPTY_FC };
    const features: Feature[] = ctx.reach.places.map((p) => ({
      type: "Feature",
      properties: { name: p.name, category: p.category },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    }));
    return { region: EMPTY_FC, points: { type: "FeatureCollection", features } };
  }

  if (tile === "crime") {
    const found = ctx.crimePrecinct !== null && ctx.citywide
      ? ctx.citywide.precincts.find((p) => p.precinct === ctx.crimePrecinct)
      : undefined;
    if (!found) return { region: EMPTY_FC, points: EMPTY_FC };
    const feature: Feature = {
      type: "Feature",
      properties: { precinct: found.precinct },
      geometry: found.geometry as unknown as Feature["geometry"],
    };
    return { region: { type: "FeatureCollection", features: [feature] }, points: EMPTY_FC };
  }

  if (tile === "noise" || tile === "trees" || tile === "building") {
    if (!ctx.selectedCell) return { region: EMPTY_FC, points: EMPTY_FC };
    const boundary = h3.cellToBoundary(ctx.selectedCell) as [number, number][];
    const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]);
    const feature: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    return { region: { type: "FeatureCollection", features: [feature] }, points: EMPTY_FC };
  }

  return { region: EMPTY_FC, points: EMPTY_FC };
}

function roughDist(a: { lat: number; lng: number }, b: LngLat): number {
  // Not geodesic -- only ever used to rank on-screen labels by proximity
  // to the current view centre, where flat-Euclidean-on-degrees is fine.
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

// ---------------------------------------------------------------------------
// Label-tier collision (2026-08-02): a client-side equivalent of MapLibre's
// own symbol-sort-key + text-allow-overlap:false collision index. Real
// `symbol` layers can't be used for this map's text (mapStyle.ts's own
// comment: no glyphs key, every label is a real DOM element in this app's
// own grotesk/mono fonts, not a pre-rendered glyph atlas) -- so
// updateLabelMarkers() below reimplements the same greedy, priority-ordered
// placement rule by hand: sort every candidate label by tier + on-screen
// relevance, project it to pixel space, and only place it if its measured
// bounding box doesn't intersect any higher- or equal-priority box already
// placed this pass. A rejected label is simply never rendered (matches
// MapLibre's default `text-optional: false` -- a colliding symbol is
// dropped whole, never shown at reduced opacity or stacked on top).
//
// TIER SPEC (see MapView.tsx's own module docstring / mapStyle.ts's parallel
// comment for why there is no third, symbol-layer-based tier):
//   Tier 1 -- neighbourhood labels (.maplabel--neighborhood). Highest
//     priority, placed first, always wins contested space against Tier 2.
//     Zoom band: >= 9.5 (city-scale orientation label, unchanged from the
//     pre-existing threshold). Within the tier, candidates are ordered by
//     distance to the current viewport centre -- bearings' own NTA-derived
//     neighbourhood data carries no population/rank field the way
//     Protomaps' own `places` basemap layer does (docs.protomaps.com/
//     basemaps/layers: real `population`/`min_zoom` attributes per place
//     feature) -- proximity-to-centre is the honest, data-backed substitute
//     for "most relevant right now," not a silently invented rank.
//   Tier 2 -- precinct labels (.maplabel--precinct). Lower priority than
//     Tier 1, placed second; a precinct label is dropped wherever it would
//     collide with any already-placed box. Zoom band: >= 11 (unchanged --
//     a finer, more technical label that only resolves once already
//     zoomed past city scale). Same distance-to-centre ordering within the
//     tier.
//   Not tiered here, both by explicit invariant elsewhere in this file:
//   pinned-place badges (effect 11's own comment: "a pinned place is never
//   silently absent," SPEC-lens-report.md §3) must never be culled by this
//   system. Subway station markers (effect 6) are bounded to a handful of
//   stations for one searched address at a time, never citywide, so their
//   collision risk is materially lower than the two citywide label sets
//   this pass addresses -- left out of scope, not silently dropped.
//   Recomputed on every `moveend` (already wired below), same as before.

interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

let labelMeasureCtx: CanvasRenderingContext2D | null | undefined;

// Lazily-created, reused canvas 2D context -- text measurement is the only
// thing it's for, so one shared offscreen context (never attached to the
// DOM) is enough; recreating one per label per moveend would be wasteful.
// Returns `null` (not throws) when unavailable -- jsdom's canvas element
// has no real 2D context without the optional native `canvas` package
// (App.test.tsx's fake MapLibre map runs this code path in exactly that
// environment), so measureLabelWidth() below falls back to a heuristic
// rather than crashing every map test.
function getLabelMeasureCtx(): CanvasRenderingContext2D | null {
  if (labelMeasureCtx === undefined) {
    labelMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  return labelMeasureCtx;
}

// Mirrors index.css's --font-mono stack exactly -- measuring against a
// different font than the one actually rendered would make the estimated
// box wrong in exactly the way that reintroduces the overlap bug this
// system exists to fix.
const LABEL_FONT_STACK = '"Cascadia Mono", "Consolas", ui-monospace, "SFMono-Regular", monospace';
const LABEL_BOX_PAD_PX = 3; // breathing room between two accepted labels, not just zero-overlap

function measureLabelWidth(upper: string, fontPx: number, letterSpacingEm: number): number {
  const ctx = getLabelMeasureCtx();
  const spacing = letterSpacingEm * fontPx * upper.length;
  if (ctx) {
    ctx.font = `${fontPx}px ${LABEL_FONT_STACK}`;
    return ctx.measureText(upper).width + spacing;
  }
  // No real Canvas2D text metrics available (see getLabelMeasureCtx()'s own
  // comment) -- fall back to a monospace-width heuristic (~0.6em per
  // character, a reasonable approximation for Cascadia Mono/Consolas)
  // rather than crashing. Only ever exercised in jsdom tests; every real
  // browser this map ships to supports measureText().
  return upper.length * fontPx * 0.6 + spacing;
}

// The screen-space box a DOM label marker will actually occupy, anchored at
// its projected centre point (both .maplabel classes use `anchor: "center"`
// in updateLabelMarkers()). `text` is measured post-uppercase since both
// classes set `text-transform: uppercase` in CSS -- that's a paint-time-only
// transform, so measuring the original mixed-case string would under-count
// width for any label with lowercase letters.
function labelBox(text: string, screenX: number, screenY: number, fontPx: number, letterSpacingEm: number): ScreenBox {
  const upper = text.toUpperCase();
  const width = measureLabelWidth(upper, fontPx, letterSpacingEm);
  const height = fontPx * 1.5; // approximates line-height for a single-line label
  return {
    left: screenX - width / 2 - LABEL_BOX_PAD_PX,
    right: screenX + width / 2 + LABEL_BOX_PAD_PX,
    top: screenY - height / 2 - LABEL_BOX_PAD_PX,
    bottom: screenY + height / 2 + LABEL_BOX_PAD_PX,
  };
}

function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function collidesWithAny(box: ScreenBox, placed: ScreenBox[]): boolean {
  return placed.some((p) => boxesOverlap(box, p));
}

// ---------------------------------------------------------------------------

export function MapView({
  address,
  selectedCell,
  onCellClick,
  activeCategories,
  pins,
  highlightedTile,
  crimePrecinct,
}: {
  // The real searched address, or `null` when the current selection came
  // from a bare grid click (no address) -- drives the local building/
  // street/subway overlay fetch (GET /api/map) AND the reach-rings fetch
  // (GET /api/reach) below, neither of which makes sense without a real
  // searched address.
  address: string | null;
  // The h3 id currently driving the report panel (App.tsx owns this) --
  // used to fly the camera there and to place the subject marker.
  selectedCell: string | null;
  // Fired when the user clicks any real cell on the citywide grid -- the
  // "click any hex to swap the report" feature (SPEC-precompute-v2.md
  // Phase 2). App.tsx owns what happens next (GET /api/cell/{h3}).
  onCellClick: (h3: string) => void;
  // Session-only preference-bar state (App.tsx owns it, no persistence
  // anywhere -- see lib/preferences.ts's own module docstring).
  activeCategories: Set<string>;
  pins: PinnedPlace[];
  // LAYOUT-V3 WAVE 1c item 4: which side-panel tile (if any) is currently
  // hovered/expanded -- CellReportView.tsx owns the hover/expand state
  // itself and reports just this one key up; see tileHighlightGeometry()
  // above for how it's turned into real map geometry (or honestly nothing,
  // for the amenities gap that function's own comment documents).
  highlightedTile: TileHighlightKey | null;
  // This cell's own crime precinct number (`cell.safety.precinct`), or
  // `null` when there's no crime data for this cell -- App.tsx passes it
  // down so tileHighlightGeometry() can look up that precinct's real
  // polygon in the already-fetched `citywide` data, without MapView taking
  // a dependency on the whole CellProfile shape for one field.
  crimePrecinct: number | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reach, setReach] = useState<Reach | null>(null);

  const [citywide, setCitywide] = useState<Citywide | null>(null);
  const citywideRef = useRef<Citywide | null>(null);
  citywideRef.current = citywide;

  // The citywide grid's own data (GET /api/cells) -- fetched exactly once
  // on mount, independent of `address`/`selectedCell`, so the (invisible)
  // click-anywhere hit layer covers the whole city before any search or
  // click ever happens.
  const [cellsIndex, setCellsIndex] = useState<CellsIndexEntry[] | null>(null);

  const labelMarkersRef = useRef<Marker[]>([]);
  const stationMarkersRef = useRef<Marker[]>([]);
  const pinMarkersRef = useRef<Marker[]>([]);
  const subjectMarkerRef = useRef<Marker | null>(null);

  // Always-current ref for the click callback -- effect 2 (below) registers
  // its MapLibre click listener exactly once per `mapReady` transition, not
  // once per render, so calling `onCellClick` directly from inside that
  // closure would capture whatever value it had the moment the listener was
  // added and never see a newer one App.tsx passes down on a later render.
  const onCellClickRef = useRef(onCellClick);
  onCellClickRef.current = onCellClick;

  // ---- 1. create the map exactly once. ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const tilesUrl = new URL("/tiles/nyc-basemap.pmtiles", window.location.origin).href;
    const map = new maplibregl.Map({
      container,
      style: buildMapStyle(tilesUrl),
      // The whole city visible on first paint -- a real bounds fit, not a
      // guessed center/zoom pair. `selectedCell`'s own flyTo effect takes
      // over once a real location is searched or clicked.
      bounds: [
        [NYC_BBOX.west, NYC_BBOX.south],
        [NYC_BBOX.east, NYC_BBOX.north],
      ],
      fitBoundsOptions: { padding: 20 },
      // Panning is clamped to the same NYC_BBOX the basemap was actually
      // baked for (basemap.py's `pmtiles extract --bbox=...`), never a
      // separately-guessed margin -- beyond it there are no tiles, no
      // buildings/streets overlay, and no citywide grid, just blank space
      // (Noah, 2026-08-02: "can currently drag on the map to a border
      // outside the loaded nyc preview, which is just blank space"). No
      // padding added around it: MapLibre's maxBounds already keeps the
      // full bbox reachable at min zoom (the initial `bounds` fit above
      // proves the whole box fits on screen at once), so there is no
      // "too tight at the edges" tradeoff to weigh against showing blank
      // space -- see test_basemap.py's own `abs=0.2` tolerance for how
      // imprecise "exact" bbox matching already is at the tile-snap level,
      // which is a reason to stay at 0 extra margin, not add one.
      maxBounds: [
        [NYC_BBOX.west, NYC_BBOX.south],
        [NYC_BBOX.east, NYC_BBOX.north],
      ],
      minZoom: 9,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    // Dev-only: exposes the live MapLibre instance for Playwright/manual
    // console verification (e.g. `map.getBounds()` after a drag, to check
    // the maxBounds clamp above numerically instead of by eyeballing
    // screenshots) -- stripped from the production bundle by Vite's
    // `import.meta.env.DEV` dead-code elimination, never shipped.
    if (import.meta.env.DEV) {
      (window as unknown as { __bearingsMap?: MapLibreMap }).__bearingsMap = map;
    }
    map.on("load", () => setMapReady(true));

    return () => {
      labelMarkersRef.current.forEach((m) => m.remove());
      labelMarkersRef.current = [];
      stationMarkersRef.current.forEach((m) => m.remove());
      stationMarkersRef.current = [];
      pinMarkersRef.current.forEach((m) => m.remove());
      pinMarkersRef.current = [];
      subjectMarkerRef.current?.remove();
      subjectMarkerRef.current = null;
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // ---- 2. real sources + layers, added once the map has actually loaded. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Sources for MapView's own local overlay layers -- populated later
    // (effects below) once real geometry has actually loaded; empty here
    // so the layers below have something to attach to at init.
    map.addSource("buildings", { type: "geojson", data: EMPTY_FC });
    map.addSource("streets", { type: "geojson", data: EMPTY_FC });
    map.addSource("subway", { type: "geojson", data: EMPTY_FC });
    map.addSource("reach-rings", { type: "geojson", data: EMPTY_FC });
    map.addSource("reach-dots", { type: "geojson", data: EMPTY_FC });
    // The citywide clickable grid's source (populated once GET /api/cells
    // resolves) -- hit-testing only, PLUS (LAYOUT-V3 WAVE 1c item 3) a real
    // numeric feature id per cell so a hover can drive `setFeatureState`
    // (see citywideCellsGeoJSON()'s own comment).
    map.addSource("citywide-cells", { type: "geojson", data: EMPTY_FC });
    // LAYOUT-V3 WAVE 1c item 4: two sources for "what the hovered/expanded
    // side-panel tile is talking about" -- one polygon region (crime's
    // precinct, or noise/trees/building's own cell), one set of points
    // (amenities' real nearby places). See tileHighlightGeometry()'s own
    // comment for why these are the only two real shapes, never a third.
    map.addSource("tile-highlight-region", { type: "geojson", data: EMPTY_FC });
    map.addSource("tile-highlight-points", { type: "geojson", data: EMPTY_FC });

    // The actual layer definitions (paint/layout/filter) live in
    // mapStyle.ts's buildOverlayLayers(), as a pure/exported function so
    // this exact layer set is unit-testable with MapLibre's real style
    // validator (mapStyle.test.ts) -- see that function's own comment for
    // the 2026-07-15 "zoom expression nested, not top-level" bug this
    // extraction guards against.
    for (const layer of buildOverlayLayers()) {
      map.addLayer(layer);
    }

    const onMoveEnd = () => updateLabelMarkers();

    // The click-to-load feature (SPEC-precompute-v2.md Phase 2): clicking
    // any real cell on the citywide grid swaps the report panel to that
    // cell. Registered on "citywide-cells-fill" -- a genuinely-transparent
    // fill layer (see mapStyle.ts's own comment) whose only job is
    // registering a hit anywhere inside a real block, not just within a
    // few pixels of an outline the way a line layer would.
    const onCitywideCellClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const h3id = f?.properties?.h3 as string | undefined;
      if (h3id) onCellClickRef.current(h3id);
    };
    const onCitywideCellEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    // LAYOUT-V3 WAVE 1c item 3 (Noah: "cursor: pointer... plus a visible
    // hover state on the block under the cursor if not already present" --
    // the cursor already changed on enter, above; a real ON-MAP highlight
    // did not). `mousemove` (not `mouseenter`) is what tracks WHICH feature
    // is hovered: the pointer can move from one polygon straight into an
    // adjacent one without the fill layer as a whole ever firing another
    // `mouseenter`/`mouseleave` pair, so only a per-move feature-id diff
    // catches that. `hoveredFeatureId` is a plain closure variable (not
    // React state) -- this handler fires on every mouse pixel of movement
    // over the grid, and mapStyle.ts's own paint expression (feature-state
    // hover) is what actually repaints, so nothing here needs a React
    // re-render.
    let hoveredFeatureId: number | null = null;
    const onCitywideCellMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const id = f?.id as number | undefined;
      if (id === undefined || id === hoveredFeatureId) return;
      if (hoveredFeatureId !== null) {
        map.setFeatureState({ source: "citywide-cells", id: hoveredFeatureId }, { hover: false });
      }
      hoveredFeatureId = id;
      map.setFeatureState({ source: "citywide-cells", id }, { hover: true });
    };
    const onCitywideCellLeave = () => {
      map.getCanvas().style.cursor = "";
      if (hoveredFeatureId !== null) {
        map.setFeatureState({ source: "citywide-cells", id: hoveredFeatureId }, { hover: false });
        hoveredFeatureId = null;
      }
    };

    map.on("click", "citywide-cells-fill", onCitywideCellClick);
    map.on("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
    map.on("mousemove", "citywide-cells-fill", onCitywideCellMove);
    map.on("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
    map.on("moveend", onMoveEnd);

    return () => {
      map.off("click", "citywide-cells-fill", onCitywideCellClick);
      map.off("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
      map.off("mousemove", "citywide-cells-fill", onCitywideCellMove);
      map.off("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
      map.off("moveend", onMoveEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // ---- 3. fetch the citywide grid's own data exactly once, independent
  // of any address/selection. Non-fatal on failure: the map/basemap/report
  // flow all still work without it, it just quietly has no clickable
  // overlay. ----
  useEffect(() => {
    let cancelled = false;
    getCellsIndex()
      .then((idx) => {
        if (!cancelled) setCellsIndex(idx.cells);
      })
      .catch(() => {
        /* non-fatal, see comment above */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 4. fetch the local building/street/subway overlay for whichever
  // real address was actually searched -- `address` is `null` for a bare
  // grid click. This must never block the citywide grid or the report
  // panel, both of which are already interactive by the time this starts. ----
  useEffect(() => {
    if (!address) {
      setGeo(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMapGeometry(address)
      .then((g) => {
        if (!cancelled) setGeo(g);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load the map.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // ---- 4b. fetch reach rings (SPEC-lens-report.md §3) for whichever real
  // address was actually searched -- same null-address gating effect 4
  // already uses. Non-fatal on failure (matching effect 3/5's own
  // established pattern): a failed reach fetch simply means no rings/dots
  // this address, not a crash -- /api/map's own `error` state already
  // reports a genuinely bad address. ----
  useEffect(() => {
    if (!address) {
      setReach(null);
      return;
    }
    let cancelled = false;
    getReach(address)
      .then((r) => {
        if (!cancelled) setReach(r);
      })
      .catch(() => {
        if (!cancelled) setReach(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // ---- 5. fetch citywide (address-independent) label data once. ----
  useEffect(() => {
    let cancelled = false;
    getCitywide()
      .then((c) => {
        if (!cancelled) setCitywide(c);
      })
      .catch(() => {
        // Non-fatal: the map still works without neighbourhood/precinct
        // labels, it just quietly has fewer layers, never a crash.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 6. push the address-scoped geometry into the map + fly to it. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geo) return;

    (map.getSource("buildings") as maplibregl.GeoJSONSource | undefined)?.setData(buildingsGeoJSON(geo));
    (map.getSource("streets") as maplibregl.GeoJSONSource | undefined)?.setData(streetsGeoJSON(geo));
    (map.getSource("subway") as maplibregl.GeoJSONSource | undefined)?.setData(subwayGeoJSON(geo));

    map.fitBounds(
      [
        [geo.bbox.west, geo.bbox.south],
        [geo.bbox.east, geo.bbox.north],
      ],
      { padding: 48, duration: 600 },
    );

    stationMarkersRef.current.forEach((m) => m.remove());
    stationMarkersRef.current = [];
    for (const s of geo.stations) {
      const el = document.createElement("div");
      el.className = "mapstation";
      el.title = s.name;
      const dot = document.createElement("span");
      dot.className = "mapstation__dot";
      el.appendChild(dot);
      if (s.routes.length > 0) {
        const bullets = document.createElement("span");
        bullets.className = "mapstation__bullets";
        for (const route of s.routes) {
          const b = document.createElement("span");
          b.className = "mapstation__bullet";
          b.textContent = route;
          b.style.backgroundColor = colorFor(route);
          bullets.appendChild(b);
        }
        el.appendChild(bullets);
      }
      stationMarkersRef.current.push(
        new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([s.lng, s.lat]).addTo(map),
      );
    }
  }, [geo, mapReady]);

  // ---- 7. push citywide geometry into the map + refresh labels. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !citywide) return;
    updateLabelMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citywide, mapReady]);

  // ---- 8. push the citywide grid's own data into the map once it's
  // loaded (independent of mapReady/data ordering -- whichever resolves
  // second triggers this). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !cellsIndex) return;
    (map.getSource("citywide-cells") as maplibregl.GeoJSONSource | undefined)?.setData(
      citywideCellsGeoJSON(cellsIndex),
    );
  }, [cellsIndex, mapReady]);

  // ---- 9. push reach rings into the map whenever the fetched data
  // changes. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("reach-rings") as maplibregl.GeoJSONSource | undefined)?.setData(
      reach ? reachRingsGeoJSON(reach) : EMPTY_FC,
    );
  }, [reach, mapReady]);

  // ---- 10. push chip-selected amenity/station dots -- a pure client-side
  // filter (spec: chip toggles must update the map "without re-searching
  // the address"), no network call here. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("reach-dots") as maplibregl.GeoJSONSource | undefined)?.setData(
      reach ? reachDotsGeoJSON(reach, activeCategories) : EMPTY_FC,
    );
  }, [reach, activeCategories, mapReady]);

  // ---- 10b. push tile-highlight geometry whenever the hovered/expanded
  // side-panel tile changes (LAYOUT-V3 WAVE 1c item 4) -- see
  // tileHighlightGeometry()'s own comment for what each tile resolves to,
  // including the honest empty case for amenities with no `reach` loaded. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const { region, points } = tileHighlightGeometry(highlightedTile, {
      reach,
      citywide,
      selectedCell,
      crimePrecinct,
    });
    (map.getSource("tile-highlight-region") as maplibregl.GeoJSONSource | undefined)?.setData(region);
    (map.getSource("tile-highlight-points") as maplibregl.GeoJSONSource | undefined)?.setData(points);
  }, [highlightedTile, reach, citywide, selectedCell, crimePrecinct, mapReady]);

  // ---- 11. pinned-place markers (SPEC-lens-report.md §3: "a pinned place
  // is never silently absent" -- always rendered, even outside every real
  // band). Walk-time badge is computed client-side from the subject point
  // (see WALK_SPEED_MPS's own comment for why this one scalar, unlike the
  // ring geometry itself, is a legitimate frontend computation) -- `null`
  // when no address/cell is currently selected, in which case the badge
  // shows the pin's own label with no fabricated minute count. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    pinMarkersRef.current.forEach((m) => m.remove());
    pinMarkersRef.current = [];

    const subject = reach?.center ?? geo?.subject ?? null;
    for (const pin of pins) {
      const el = document.createElement("div");
      el.className = "pinmarker";
      const dot = document.createElement("span");
      dot.className = "pinmarker__dot";
      el.appendChild(dot);
      const badge = document.createElement("span");
      badge.className = "pinmarker__badge";
      const minutes = subject ? Math.round(haversineM(subject, pin) / WALK_SPEED_MPS / 60) : null;
      badge.textContent = minutes === null ? pin.label : `${pin.label} — ${minutes} min`;
      el.appendChild(badge);
      pinMarkersRef.current.push(
        new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([pin.lng, pin.lat]).addTo(map),
      );
    }
  }, [pins, reach, geo, mapReady]);

  // ---- 12. the subject marker -- replaces the old hex-outline "which
  // block is selected" signal (RETIRED 2026-07-29, see this file's own top
  // comment) with one small, real DOM marker at the exact geocoded point
  // for a searched address, or the cell's own centroid for a bare grid
  // click (no exact point exists for that case). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    subjectMarkerRef.current?.remove();
    subjectMarkerRef.current = null;

    let point: { lat: number; lng: number } | null = geo?.subject ?? null;
    if (!point && selectedCell) {
      const [lat, lng] = h3.cellToLatLng(selectedCell);
      point = { lat, lng };
    }
    if (!point) return;

    const el = document.createElement("div");
    el.className = "mapsubject";
    subjectMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
  }, [geo, selectedCell, mapReady]);

  // ---- 13. fly the camera to whichever cell is selected -- computed
  // straight from the real h3 id via h3-js's own cellToLatLng(), so this
  // never has to wait on GET /api/cells or GET /api/map to know where to
  // go (the map must stay responsive even while the slower local overlay
  // is still loading). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !selectedCell) return;
    const [lat, lng] = h3.cellToLatLng(selectedCell);
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15), speed: 1.2 });
  }, [selectedCell, mapReady]);

  function updateLabelMarkers() {
    const map = mapRef.current;
    const cw = citywideRef.current;
    if (!map || !cw) return;

    labelMarkersRef.current.forEach((m) => m.remove());
    labelMarkersRef.current = [];

    const bounds = map.getBounds();
    const center = map.getCenter();
    const zoom = map.getZoom();

    // Level-of-detail by zoom (VISUAL.md §5): neighbourhood names are the
    // city-scale orientation label, so they appear near this map's own
    // minZoom (9); precinct numbers are a finer, more technical label and
    // only resolve in once you're already zoomed past city scale. 262
    // neighbourhoods and 78 precinct numbers rendered unconditionally
    // citywide would be unreadable clutter at any zoom either way, so both
    // are still capped to the nearest N actually inside the current view
    // (DOM markers, not GPU-rendered symbols, so an unbounded count would
    // also be a real perf cost). Placement within each tier -- and between
    // Tier 1/Tier 2 -- now runs through the greedy collision placer
    // (labelBox()/collidesWithAny(), see this file's own "Label-tier
    // collision" spec comment above) so no two accepted labels' boxes
    // overlap on screen, at any zoom.
    const placedBoxes: ScreenBox[] = [];

    if (zoom >= 9.5) {
      const candidates = cw.neighborhoods
        .filter((n) => bounds.contains([n.lng, n.lat]))
        .sort((a, b) => roughDist(a, center) - roughDist(b, center))
        .slice(0, 40);
      for (const n of candidates) {
        const p = map.project([n.lng, n.lat]);
        const box = labelBox(n.name, p.x, p.y, 10, 0.05); // mirrors .maplabel--neighborhood
        if (collidesWithAny(box, placedBoxes)) continue;
        placedBoxes.push(box);
        const el = document.createElement("div");
        el.className = "maplabel maplabel--neighborhood";
        el.textContent = n.name;
        labelMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([n.lng, n.lat]).addTo(map),
        );
      }
    }

    if (zoom >= 11) {
      const candidates = cw.precincts
        .filter((p) => bounds.contains([p.lng, p.lat]))
        .sort((a, b) => roughDist(a, center) - roughDist(b, center))
        .slice(0, 30);
      for (const pr of candidates) {
        const text = `Police area ${pr.precinct}`;
        const p = map.project([pr.lng, pr.lat]);
        const box = labelBox(text, p.x, p.y, 9, 0.08); // mirrors .maplabel--precinct
        if (collidesWithAny(box, placedBoxes)) continue;
        placedBoxes.push(box);
        const el = document.createElement("div");
        el.className = "maplabel maplabel--precinct";
        el.textContent = text;
        labelMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([pr.lng, pr.lat]).addTo(map),
        );
      }
    }
  }

  // LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 2,
  // Noah: interface-narration captions like this one "appear for no clear
  // reason"): the old leading entry here ("Click anywhere on the map to
  // see that block's real record") told the user the map was clickable in
  // WORDS. Item 3/4 of the same wave give the map a real, felt affordance
  // instead -- a pointer cursor plus a visible highlight fill over
  // whichever block is under the cursor (see effect 2 below) -- so the
  // fact is now demonstrated, not narrated, and this caption is redundant
  // with it. Screen readers still get the equivalent fact: the map
  // canvas's own `aria-label` below already states "Every real city block
  // is clickable to load its record," so nothing is lost for anyone who
  // can't see the cursor change.
  const legend = useMemo(
    () => [
      ...(geo
        ? [
            { swatch: { background: STEEL, opacity: 0.34 }, label: "Buildings" },
            { swatch: { background: INK, height: 2 }, label: "Streets, by size" },
            { swatch: { background: RED }, label: "Subway & PATH lines" },
          ]
        : []),
      {
        swatch: { background: RED, borderRadius: "50%", width: 8, height: 8 },
        label: "The searched or selected block",
      },
      ...(reach
        ? [
            {
              swatch: { background: RED, opacity: 0.22, borderRadius: "50%", width: 12, height: 12 },
              label: "Roughly a 5, 10, 15-minute walk — a straight line, not a real route",
            },
          ]
        : []),
      ...(reach && activeCategories.size > 0
        ? [
            {
              swatch: { background: INK, borderRadius: "50%", width: 7, height: 7 },
              label: "Nearby places you've turned on above",
            },
          ]
        : []),
      ...(pins.length > 0
        ? [
            {
              swatch: { background: RED, borderRadius: "50%", width: 8, height: 8 },
              label: "Pinned places, however far",
            },
          ]
        : []),
    ],
    [geo, reach, activeCategories, pins],
  );

  // LAYOUT-V3 WAVE 1 (2026-08-02, SPEC-layout-v3.md §2/§3): the old
  // `.mapfield__stage` two-column grid and its second column -- the
  // "What's here" hover-legend `.readout` panel -- are both gone from this
  // component. App.tsx now owns the map + side-panel two-column grid at the
  // page level (`.mapgrid`, wrapping this whole component plus the real
  // per-block stat cards from CellReportView), so MapView renders as a
  // single stacked column of its own map chrome (controls, frame, legend,
  // notes) and lets the page-level grid decide what sits beside it.
  //
  // LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c items 1/2):
  // two changes to this return, together:
  //   - The decorative "The neighbourhood, navigable" kicker (item 2) is
  //     gone outright -- it named the map for the user without helping
  //     them do anything, and nothing in this file's own markup ever
  //     pointed an `aria-labelledby` at it, so nothing else depended on it
  //     existing (confirmed by reading the rest of this file/App.tsx
  //     before removing it, not assumed).
  //   - `.mapfield__frame` (the actual canvas) now renders FIRST, with the
  //     lens-view controls moved below it (item 1, "top-align tiles with
  //     the map CANVAS, not the card"): with the kicker gone too, nothing
  //     variable-height precedes the frame any more, so `.mapfield`'s own
  //     fixed top padding is the only remaining gap between the card's
  //     border and the canvas -- see index.css's own comment on
  //     `.mapfield`/`.mapfield__frame` for the measured before/after
  //     numbers this reordering makes possible.
  return (
    <div className="mapfield">
      <div className="mapfield__frame">
        <div
          ref={containerRef}
          className="mapfield__map"
          role="img"
          aria-label="Navigable map of New York City. Every real city block is clickable to load its record; shows building outlines, streets, subway lines, and walk-time rings for the selected address."
        />
      </div>

      <div className="mapfield__controls">
        <span>Map view</span>
        <div className="lensbar" role="group" aria-label="Map view">
          <button type="button" className="lensbar__option" aria-pressed="true">
            minimal
          </button>
          <button type="button" className="lensbar__option" disabled aria-disabled="true" title="Coming in a future update">
            transit + 3d — coming soon
          </button>
        </div>
      </div>

      <div className="mapfield__legend">
        {legend.map((item, i) => (
          <span key={i}>
            {item.swatch && <i style={item.swatch} />}
            {item.label}
          </span>
        ))}
      </div>
      {loading && <p className="mapfield__status mono">Loading the neighbourhood record…</p>}
      {error && <p className="mapfield__status mapfield__status--error mono">{error}</p>}

      {geo && <p className="mapfield__note mono">{geo.basemap_note}</p>}
      {reach && <p className="mapfield__note mono">{reach.method_note}</p>}
    </div>
  );
}
