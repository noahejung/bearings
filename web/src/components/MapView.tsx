import * as h3 from "h3-js";
import type { Feature, FeatureCollection } from "geojson";
import maplibregl, { type LngLat, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";
import { ApiError, getCellsIndex, getCitywide, getMapGeometry, getReach } from "../api";
import { buildMapStyle, buildOverlayLayers, DESTINATION_ENTER_MS, DESTINATION_EXIT_MS } from "../lib/mapStyle";
import type { PinnedPlace } from "../lib/preferences";
import type { CellsIndexEntry, Citywide, Era, MapGeometry, Reach, Source } from "../types";
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
// local building/street/subway overlay AND the reach-dots feature (chip-
// selected nearby places/stations) for whichever address was actually
// searched -- it can be `null` (a bare cell click has no address), in
// which case both are simply empty, never fetched, never blocking.
//
// RETIRED 2026-07-29 (SPEC-lens-report.md, Noah: "i wanna move away from
// hex grid styling anyways, its too much visual clutter and doesnt make a
// lot of sense for the average user"): the visible H3 grid, the local
// per-address metric-shaded disk, and the crime-choropleth precinct layer
// are all gone from the map. H3 stays the backend's own data/aggregation
// layer (untouched -- reach.py/mapgeo.py/cellprofile.py), it is simply
// never drawn here anymore; "click any block to load its report" survives
// via the already-transparent hit-test fill (see mapStyle.ts's own
// updated comment). Replacing them: chip-selected amenity/station dots +
// pinned-place badges (SPEC-lens-report.md §2-4), and a two-entry lens-
// switcher stub ("minimal" is the only real lens this slice; a disabled
// second slot exists so slice 2's transit/green/3D-tilt lenses have
// somewhere to land). The 5/10/15-minute walk RINGS this same paragraph
// used to also list here were themselves later removed -- Wave 6c item 6
// (2026-08-11), see reachDotsGeoJSON()'s own neighbouring comment.

// Mirrors bearings/config.py's NYC_BBOX -- used ONLY to frame the initial
// view so the whole city is visible on first paint. This is NOT how "real
// cell" is decided (that stays the backend's data-derived job, see
// cellprofile.py's own module docstring) -- it is purely a camera bound.
const NYC_BBOX = { south: 40.47, north: 40.93, west: -74.30, east: -73.70 };

// LAYOUT-V3 WAVE 6c item 4 (2026-08-11, Noah, on the deployed pitched map:
// "trim this down to a more reasonable piece in terms of where we can drag
// to. keep a bit since we have the tiltable angle... no white horizon is
// visible"). The DRAG clamp is now a separate, tighter box than NYC_BBOX
// (which stays the initial-fit bounds above, unchanged -- the whole city
// is still what greets a first paint). MEASURED, not guessed: fetched
// GET /api/cells live (7,018 real H3 cells, matching this project's own
// "~7,400 cells citywide" figure) and took the actual min/max lat/lng
// across every real cell -- the TRUE data footprint, not the raw bake
// bbox. That measurement: lat 40.4972-40.9136, lng -74.2552 to -73.6987.
// Critically, the real cell footprint's EAST edge (-73.6987) already sits
// slightly PAST NYC_BBOX's own east edge (-73.70) -- Queens/Nassau-border
// cells are already right at the bake's edge with zero spare margin, so
// the east side below is deliberately left AT NYC_BBOX, not trimmed
// inward (trimming it would clip real, servable report cells, the one
// thing this app can never do). The other three sides had real headroom
// between the bake box and the true data footprint, so each is pulled in
// by a margin sized off that side's own measured slack (not a single
// uniform number, since the slack itself isn't uniform): west by ~0.02
// deg (~2.2 km, well inside its 0.045 deg of real slack), south by ~0.015
// deg (~1.7 km, inside its 0.027 deg slack). North is pulled in almost to
// the real data edge itself (~0.005 deg / ~500m buffer, not the ~1.1 km
// the other sides get) -- this is also WAVE 6c item 2's fix for this one
// side (Noah: "we never got rid of roads from outside our map area"):
// real Westchester/Yonkers roads north of the Bronx render with no fade
// at all (unlike the west side, which the existing NJ_MASK_POLYGON in
// mapStyle.ts already dims), so the honest fix here is minimizing how
// much of that unmasked area is even reachable, not adding a second mask
// polygon for a ~500m sliver. The same item 2 finding on the OTHER two
// unmasked sides: south is open water beyond Staten Island/the Rockaways
// (Raritan Bay/the Atlantic) at every zoom tested -- no real roads there
// to leak through, nothing to fix; east has zero spare measured margin at
// all (this comment's own east-edge finding above), and the live-verified
// screenshot at this wave's own reachable east edge (-73.71, 40.75) showed
// only real, still-NYC Queens neighbourhoods (Bayside, Douglaston-Little
// Neck, Glen Oaks) -- not actually out-of-scope, so no fix was needed
// there either.
const MAX_DRAG_BOUNDS = { south: 40.485, north: 40.918, west: -74.28, east: -73.70 };

// LAYOUT-V3 WAVE 6c items 1+4 (2026-08-11). ROOT CAUSE (item 1, "weird
// triangle shading bugs"), found by live pitch-sweep screenshots, not
// guessed: MapLibre GL triangulates each vector-tile layer's polygons PER
// TILE (earcut on each tile's own clipped copy of a feature); at pitch 0
// this is imperceptible (a sub-pixel seam at a tile boundary reads as
// nothing under a near-orthographic top-down view), but under this map's
// perspective projection at high pitch, that same sub-pixel world-space
// gap gets magnified into a visible dark wedge exactly where a translucent
// fill layer (open-space @ 0.22 opacity, water @ 0.5, the doubled
// "water-unmasked" layer) crosses a tile boundary. Reproduced concretely
// at JFK Airport's own tile boundary (-73.8, 40.63, zoom 12): a sharp
// diagonal dark sliver cutting across the airport's open-space fill,
// absent at pitch 0/20/30/40/50, visible only at pitch 55-60. Rather than
// fight per-tile triangulation (a MapLibre GL rendering characteristic,
// not a bug in this app's own style/data -- see the Wave 1f "Kill van
// Kull" diagonal-seam entry in this project's own history for the same
// class of imprecision, honestly documented rather than chased), the
// direct fix is capping how far into that perspective-amplified regime
// the map ever renders: `maxPitch` overrides MapLibre's own default (60)
// down to 50, the highest value that stayed clean across every pitch-
// sweep screenshot taken for this diagnosis. Still a real, felt tilt
// (Noah's own "tiltable angle" is explicitly kept, not removed) -- just
// short of the extreme where both the JFK seam AND the "look past the
// data edge toward the horizon" risk maxBounds alone can't fully close
// (a pitched camera's visible ground footprint grows with pitch; less
// pitch means less of it can ever fall outside MAX_DRAG_BOUNDS above,
// which is why this constant is listed as part of item 4's fix too).
const MAX_PITCH = 50;

// Mirrors bearings/transit.py's WALK_SPEED_MPS -- the same "Mirrors ..."
// duplication pattern NYC_BBOX above already uses. Two real uses: a pinned
// place's own walk-time badge (a single scalar), and the getting-around
// destination zone preview's own ring polygon math (destinationRingsGeoJSON()
// below, mirroring bearings/reach.py's band_radius_m()/_ring_polygon()
// formula -- see that function's own comment). The searched-address ring
// polygons this same constant used to ALSO help format (via the now-removed
// reachRingsGeoJSON(), Wave 6c item 6) came pre-computed from the backend
// instead -- WALK_SPEED_MPS itself was never that function's own math, only
// this file's two still-live client-side computations use it.
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

// LAYOUT-V3 WAVE 1e: every footprint now carries its own real bbl/year/era/
// residential/hazard properties (MapGeometry's MapBuilding, see types.ts's
// own comment for the None-vs-0 rules) -- mapStyle.ts's per-building layers
// read `residential`/`hazard_class_c` straight off these properties (via
// `["get", ...]`), and the click/hover handlers below read all five off
// whichever feature `queryRenderedFeatures`/the mousemove hit returns. A
// real numeric top-level `id` (index into this one fetch's own array,
// stable only within it -- same convention citywideCellsGeoJSON() already
// uses, same reason: MapLibre's `setFeatureState` only works against a
// real numeric GeoJSON feature id) drives the hover fill in
// mapStyle.ts's buildOverlayLayers().
function buildingsGeoJSON(geo: MapGeometry): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: geo.buildings.map((b, i) => ({
      type: "Feature",
      id: i,
      properties: {
        bbl: b.bbl,
        year_built: b.year_built,
        era: b.era,
        residential: b.residential,
        hazard_class_c: b.hazard_class_c,
      },
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

// WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the route-line preview --
// filters the SAME already-loaded subway_lines array (fetched once per
// address, no second geometry request) down to just the real shape_id(s)
// GET /api/route said a computed commute actually rode. `shapeIds` is
// `null`/empty whenever there's nothing to draw (route-lines toggle off, no
// active destination, or the active one has no real transit component) --
// an empty FeatureCollection in every one of those cases, never a
// fabricated or interpolated line (SPEC-layout-v3.md Wave 4's own binding
// rule: "Route lines only ever drawn from a genuinely computed route").
function routeLineGeoJSON(geo: MapGeometry | null, shapeIds: string[] | null): FeatureCollection {
  if (!geo || !shapeIds || shapeIds.length === 0) return EMPTY_FC;
  const wanted = new Set(shapeIds);
  return {
    type: "FeatureCollection",
    features: geo.subway_lines
      .filter((line) => wanted.has(line.shape_id))
      .map((line) => ({
        type: "Feature",
        properties: { route: line.route },
        geometry: {
          type: "LineString",
          coordinates: line.coords.map(([lat, lng]): [number, number] => [lng, lat]),
        },
      })),
  };
}

// LAYOUT-V3 WAVE 6c item 6 (2026-08-11, Noah, on the deployed map: "the 5/10/
// 15-minute walk rings around searched addresses aren't helpful either").
// The ring-drawing function that used to live here (reachRingsGeoJSON(),
// formatting reach.bands's polygon coordinates for the now-deleted
// "reach-rings" source/layers) is removed outright, not hidden -- the same
// "retired, not just unhooked" standard mapStyle.ts's own citywide-cells-
// outline removal (2026-07-29) already set. `reach.bands` itself (the
// backend's ring polygon geometry, bearings/reach.py's _bands()/
// _ring_polygon()) is left alone on the backend -- band_radius_m()/
// _band_for() underneath it are NOT dead: reachDotsGeoJSON() below still
// depends on every place/station's own `band_minutes` tag, which those same
// functions compute (see reach.py's own docstring). Only the RING SHAPE
// itself (the `bands` field's `polygon` coordinates) has no remaining
// frontend reader after this wave -- flagged, not silently pruned, in this
// wave's own report, since removing it is a backend/API-contract change
// this frontend-scoped wave deliberately didn't reach into.
//
// KEPT, verified before deleting anything (per this wave's own dispatch):
// the getting-around region's destination zone preview
// (destinationRingsGeoJSON()/destinationPointGeoJSON() below) is a fully
// separate, client-side-only computation -- it mirrors reach.py's ring
// FORMULA (same WALK_SPEED_MPS constant, same circle math, see
// DESTINATION_PREVIEW_BANDS_MINUTES's own comment below) but never reads
// `reach.bands` or any other server-provided ring geometry, so removing the
// searched-address rings above cannot regress it -- confirmed by reading
// every call site of `reach` in this file before making this change, not
// assumed from the two features merely looking similar.

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

// MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3): "map
// layers... ease opacity rather than snapping" -- for MapLibre's own native
// paint-property `-transition` to actually animate anything (mapStyle.ts's
// own comment on citywide-cells-fill/tile-highlight-* for why), the SAME
// feature has to persist across the change; a genuinely NEW feature
// appearing via `setData()` (which is what a bare EMPTY_FC <-> populated
// toggle produces every time a hover starts/ends) has no prior rendered
// frame for the renderer to interpolate FROM. Several sources on this map
// (tile-highlight-region/points, destination-rings/point) legitimately go
// empty whenever nothing is currently hovered -- this helper is the fix:
// instead of collapsing back to EMPTY_FC, it re-emits the LAST real
// geometry this source ever held, tagged `visible: false`, so the shape
// that's disappearing is the SAME feature fading its opacity down (a real,
// GPU-side transition) rather than abruptly vanishing. The very first-ever
// hover of a session has no "last known" geometry to fall back to yet, so
// that one specific case still pops in without a fade -- a deliberate,
// documented limitation (see this wave's own report), not an oversight.
// mapStyle.ts's paint expressions read this same `visible` property
// (defaulting `true` when absent, so any OTHER, non-faded source on this
// map that never sets it is unaffected).
function withFadeFallback(
  current: FeatureCollection,
  lastRef: { current: FeatureCollection | null },
): FeatureCollection {
  if (current.features.length > 0) {
    const tagged: FeatureCollection = {
      type: "FeatureCollection",
      features: current.features.map((f) => ({ ...f, properties: { ...f.properties, visible: true } })),
    };
    lastRef.current = tagged;
    return tagged;
  }
  if (lastRef.current) {
    return {
      type: "FeatureCollection",
      features: lastRef.current.features.map((f) => ({ ...f, properties: { ...f.properties, visible: false } })),
    };
  }
  return EMPTY_FC;
}

// LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.3 "Zone preview") -- hovering or
// selecting any getting-around bar (a default ANCHOR or a custom
// destination) draws the SAME straight-line 5/10/15-minute walk rings
// reach.py's own band_radius_m()/_ring_polygon() already compute for the
// searched-address rings above, this time centred on the DESTINATION.
// Recomputed here, client-side, rather than fetched from a new backend
// endpoint -- this is pure circle trigonometry with no data dependency (no
// places/stations lookup, unlike the real /api/reach rings), so a network
// round-trip on every hover would add real latency for zero real benefit.
// Mirrors reach.py's REACH_BANDS_MINUTES = (5, 10, 15) and its
// band_radius_m()/`_ring_polygon()` formulas exactly (same
// WALK_SPEED_MPS constant this file already mirrors above, same
// longitude-correction-by-latitude math) -- see this project's Wave 3
// report for the live side-by-side confirmation that this client port
// reproduces the backend's own ring geometry.
const DESTINATION_PREVIEW_BANDS_MINUTES = [5, 10, 15] as const;

// LAYOUT-V3 WAVE 1f item 2 (2026-08-11): the "Honest caption for the zone
// preview" this constant used to hold no longer renders inline below the
// map -- see this file's own comment further down (where the note used to
// render) for why, and DisclosurePage.tsx's "Reading the map" section for
// where its exact text lives now (moved verbatim, not deleted).

function destinationRingPolygon(lat: number, lng: number, radiusM: number, n = 64): [number, number][] {
  const dLatPerM = 1 / 111_320;
  const dLngPerM = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    // +1 above closes the ring, matching reach.py's own `range(n + 1)`.
    const theta = (2 * Math.PI * i) / n;
    const dLat = radiusM * Math.sin(theta) * dLatPerM;
    const dLng = radiusM * Math.cos(theta) * dLngPerM;
    ring.push([lng + dLng, lat + dLat]); // GeoJSON order: [lng, lat]
  }
  return ring;
}

// UX-FIX 2026-08-03 (audit finding #3, "layered map highlights compound
// into an illegible wall of red"): every feature below now carries a real
// `dimmed` boolean, read by mapStyle.ts's buildDestinationPreviewLayers()
// paint expressions -- see MapView's own "HIGHLIGHT PRIORITY RULE" comment
// on effect 10c below for what sets it and why.
function destinationRingsGeoJSON(
  point: { lat: number; lng: number } | null,
  dimmed: boolean,
): FeatureCollection {
  if (!point) return EMPTY_FC;
  // Largest band first -- a later feature in the same GeoJSON source paints
  // on top of an earlier one, so the smallest/darkest band always ends up
  // visually "inside" the larger/fainter ones without needing three
  // separate layers (the same draw-order technique the now-removed
  // reachRingsGeoJSON() used to also rely on for the searched-address
  // rings, Wave 6c item 6).
  const ordered = [...DESTINATION_PREVIEW_BANDS_MINUTES].sort((a, b) => b - a);
  return {
    type: "FeatureCollection",
    features: ordered.map((minutes) => ({
      type: "Feature",
      properties: { minutes, dimmed },
      geometry: {
        type: "Polygon",
        coordinates: [destinationRingPolygon(point.lat, point.lng, WALK_SPEED_MPS * minutes * 60)],
      },
    })),
  };
}

function destinationPointGeoJSON(
  point: { lat: number; lng: number } | null,
  dimmed: boolean,
): FeatureCollection {
  if (!point) return EMPTY_FC;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { dimmed },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] },
      },
    ],
  };
}

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
//   - "crime"/"noise"/"trees" -> a real AREA. Crime is a precinct-level
//     percentile (bearings/citywide.py) attributed to this block, so its
//     honest region is the precinct's own real polygon (already fetched
//     once, address-independent, via GET /api/citywide, for the
//     precinct-label layer) -- looked up by the exact precinct number this
//     cell's own report carries. Noise/trees are each counted over exactly
//     ONE h3 cell (cellprofile.py: no ring, no radius -- see
//     CellReportView.tsx's own top comment), so their honest region is that
//     literal cell boundary, computed client-side from its h3 id (the same
//     h3-js call citywideCellsGeoJSON() already makes per cell above) -- no
//     extra fetch, no approximation beyond what the number itself already
//     represents.
//   - "building" no longer exists as a tile key at all (LAYOUT-V3 WAVE 1e):
//     building age/hazards left the tile grid entirely and are now a real
//     per-building map interaction of their own (buildBuildingInfoElement()
//     below), not something a side-panel tile hover highlights.
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

  if (tile === "noise" || tile === "trees") {
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
//     tier. WAVE 6b (2026-08-11, Noah: "i dont need the police area labels
//     when im not specifically selecting to show it") -- ALSO gated on
//     `showPoliceLabelsRef.current` (crime tile hover/highlight active),
//     on top of the zoom band: at rest, precinct labels render never, only
//     while a real crime-context signal is live. Neighbourhood labels (Tier
//     1) are unaffected -- they stay the standing city-scale orientation
//     label this app already shows unconditionally.
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
// Per-building info panel (LAYOUT-V3 WAVE 1e, SPEC-layout-v3.md §8, Noah:
// "what's stopping us from searching up every livable building and mapping
// that out"). Building age and hazards leave the side-panel tile grid
// (CellReportView.tsx no longer renders that tile) and become a real map
// interaction: hovering/clicking a residential building's own footprint
// shows THAT building's own real year/hazard record, not the block's
// average. A hand-built DOM element behind a real `maplibregl.Marker`,
// matching this file's own established idiom for map-anchored info
// (`.mapstation`, `.pinmarker`) rather than MapLibre's own `Popup` (which
// this app has never used, and whose default chrome -- rounded corners,
// box-shadow -- would need overriding to match VISUAL.md's "no drop
// shadows, no gradients" rule anyway).
const BUILDING_ERA_LABELS: Record<string, string> = {
  prewar: "Pre-war",
  postwar: "Post-war",
  modern: "Modern",
};

interface BuildingFeatureProps {
  bbl: string | null;
  year_built: number | null;
  era: Era;
  hazard_class_c: number | null;
}

function buildBuildingInfoElement(
  props: BuildingFeatureProps,
  sources: { building_age?: Source; hazards?: Source },
  onClose: () => void,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "buildinginfo";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "buildinginfo__close";
  close.setAttribute("aria-label", "Close this building's record");
  close.textContent = "×";
  close.addEventListener("click", onClose);
  el.appendChild(close);

  const yearP = document.createElement("p");
  yearP.className = "buildinginfo__value";
  if (props.year_built !== null) {
    const yearSpan = document.createElement("span");
    yearSpan.textContent = String(props.year_built);
    yearP.appendChild(yearSpan);
    if (props.era) {
      const era = document.createElement("span");
      era.className = "era";
      era.textContent = BUILDING_ERA_LABELS[props.era] ?? props.era;
      yearP.appendChild(era);
    }
  } else {
    yearP.classList.add("buildinginfo__value--empty");
    yearP.textContent = "No property record on file";
  }
  el.appendChild(yearP);

  const hazardP = document.createElement("p");
  hazardP.className = "buildinginfo__value";
  if (props.hazard_class_c === null) {
    hazardP.classList.add("buildinginfo__value--empty");
    hazardP.textContent = "No hazard record on file";
  } else if (props.hazard_class_c > 0) {
    hazardP.classList.add("buildinginfo__value--flag");
    hazardP.textContent = `${props.hazard_class_c} serious hazard${props.hazard_class_c === 1 ? "" : "s"} flagged`;
  } else {
    hazardP.textContent = "No hazards flagged";
  }
  el.appendChild(hazardP);

  const sourceNames = [sources.building_age?.name, sources.hazards?.name].filter(
    (n): n is string => Boolean(n),
  );
  if (sourceNames.length > 0) {
    const sourceP = document.createElement("p");
    sourceP.className = "buildinginfo__source mono";
    sourceP.textContent = sourceNames.join(" · ");
    el.appendChild(sourceP);
  }

  return el;
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
  destinationHighlight,
  routeHighlight,
}: {
  // The real searched address, or `null` when the current selection came
  // from a bare grid click (no address) -- drives the local building/
  // street/subway overlay fetch (GET /api/map) AND the reach fetch
  // (GET /api/reach, feeding the chip-selected amenity/station dots)
  // below, neither of which makes sense without a real searched address.
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
  // LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.3 "Zone preview"): whichever
  // getting-around destination (a default ANCHOR or a custom row) is
  // currently hovered/selected, or `null` when none is -- GettingAroundField
  // owns that hover/select state itself and reports just the resolved
  // point up, the same "child owns the interaction, parent just relays a
  // point/key" shape onTileHighlight/highlightedTile already establishes.
  destinationHighlight: { lat: number; lng: number } | null;
  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the real GTFS shape_id(s)
  // for the currently active destination's actual ridden line(s), or `null`
  // when there's nothing to draw as a real line (route-lines toggle off, no
  // active destination, or the active one has no real transit component).
  // Same "child owns it, parent relays a value" shape as destinationHighlight
  // above -- GettingAroundField owns the toggle state and the GET
  // /api/route fetch, this prop is just the resolved result.
  routeHighlight: string[] | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LAYOUT-V3 WAVE 1e: always-current ref mirroring `geo` -- effect 2's
  // building click handler (registered once per `mapReady`, same
  // stale-closure reasoning as `onCellClickRef` below) needs whichever
  // `geo.sources` is current at click time (for the info panel's own
  // citation line), not whatever it was when the listener was first added.
  const geoRef = useRef<MapGeometry | null>(null);
  geoRef.current = geo;

  const [reach, setReach] = useState<Reach | null>(null);
  // UX-FIX 2026-08-03 (audit finding #4, "amenities-tile hover has a silent
  // race condition"): true only WHILE a real address's own reach fetch is
  // actually in flight -- distinct from `!reach`, which is also true before
  // any address is searched at all, or after a genuinely failed fetch (see
  // effect 4b below). Lets the render below tell "still loading" apart from
  // "no address" or "gave up" -- the exact None-vs-0-style distinction this
  // project's own rules require elsewhere, applied to a loading state.
  const [reachLoading, setReachLoading] = useState(false);

  const [citywide, setCitywide] = useState<Citywide | null>(null);
  const citywideRef = useRef<Citywide | null>(null);
  citywideRef.current = citywide;

  // WAVE 6b (2026-08-11, SPEC-layout-v3.md §8, Noah: "i dont need the police
  // area labels when im not specifically selecting to show it"). Whether
  // crime context is currently active -- a real hover on the side panel's
  // crime tile, the SAME signal that already drives tileHighlightGeometry()
  // into drawing the crime tile's own precinct-polygon highlight (see that
  // function's own "crime" branch above), reused here rather than a second,
  // independent flag. A ref (not read from `highlightedTile` directly
  // inside updateLabelMarkers()) because that function is also called from
  // effect 2's `onMoveEnd` closure, registered ONCE per `mapReady`
  // transition -- the same stale-closure risk this file's own
  // onCellClickRef/geoRef/citywideRef already guard against elsewhere.
  const showPoliceLabelsRef = useRef(false);
  showPoliceLabelsRef.current = highlightedTile === "crime";

  // The citywide grid's own data (GET /api/cells) -- fetched exactly once
  // on mount, independent of `address`/`selectedCell`, so the (invisible)
  // click-anywhere hit layer covers the whole city before any search or
  // click ever happens.
  const [cellsIndex, setCellsIndex] = useState<CellsIndexEntry[] | null>(null);

  const labelMarkersRef = useRef<Marker[]>([]);
  const stationMarkersRef = useRef<Marker[]>([]);
  const pinMarkersRef = useRef<Marker[]>([]);
  const subjectMarkerRef = useRef<Marker | null>(null);
  // LAYOUT-V3 WAVE 1e: the one, currently-open per-building info marker (or
  // `null` when none is open) -- unlike the arrays above, at most one of
  // these is ever on screen at a time (clicking a different building, or
  // anywhere that isn't a residential building's own footprint, replaces
  // or clears it -- see effect 2's own onCitywideCellClick comment).
  const buildingInfoMarkerRef = useRef<Marker | null>(null);

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
      // Panning is clamped to MAX_DRAG_BOUNDS (its own comment above has
      // the full 2026-08-11 Wave 6c measurement/reasoning) -- originally
      // this was the raw NYC_BBOX bake box itself (Noah, 2026-08-02: "can
      // currently drag on the map to a border outside the loaded nyc
      // preview, which is just blank space"), now pulled in on three of
      // its four sides toward the real, measured citywide-cell footprint.
      maxBounds: [
        [MAX_DRAG_BOUNDS.west, MAX_DRAG_BOUNDS.south],
        [MAX_DRAG_BOUNDS.east, MAX_DRAG_BOUNDS.north],
      ],
      minZoom: 9,
      maxZoom: 18,
      maxPitch: MAX_PITCH,
    });
    // WAVE 6c item 3 (2026-08-11, Noah: "give me a compass to reorient the
    // map"). `showCompass: true` restores MapLibre's own built-in compass
    // button into this SAME NavigationControl group (already restyled to
    // this app's tDR chrome via index.css's `.maplibregl-ctrl-group`
    // selector, which applies to any control in the group generically --
    // no new CSS needed) rather than a hand-built second control, so it
    // sits directly below the existing zoom +/- buttons as one visually
    // continuous control, the existing zoom-control idiom Noah asked to
    // stay consistent with. Clicking it resets bearing to 0 (MapLibre's
    // own default behavior) -- "reorient" is exactly a bearing reset, and
    // this map's own bearing can already drift via drag-to-rotate (the
    // default `dragRotate`, never disabled anywhere in this file).
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
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
      buildingInfoMarkerRef.current?.remove();
      buildingInfoMarkerRef.current = null;
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
    // LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.3): the getting-around region's
    // zone preview -- see destinationRingsGeoJSON()/destinationPointGeoJSON()
    // above for what these hold, and mapStyle.ts's buildDestinationPreviewLayers()
    // for how they're painted.
    map.addSource("destination-rings", { type: "geojson", data: EMPTY_FC });
    map.addSource("destination-point", { type: "geojson", data: EMPTY_FC });
    // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the route-line preview
    // -- see routeLineGeoJSON()'s own comment above for what this holds,
    // and mapStyle.ts's "route-line-highlight" layer for how it's painted.
    map.addSource("route-line", { type: "geojson", data: EMPTY_FC });

    // The actual layer definitions (paint/layout/filter) live in
    // mapStyle.ts's buildOverlayLayers(), as a pure/exported function so
    // this exact layer set is unit-testable with MapLibre's real style
    // validator (mapStyle.test.ts) -- see that function's own comment for
    // the 2026-07-15 "zoom expression nested, not top-level" bug this
    // extraction guards against.
    for (const layer of buildOverlayLayers()) {
      map.addLayer(layer);
    }

    // MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3):
    // real GPU-side paint-property transitions for every layer whose
    // opacity/radius can now change without a hard pop -- set here, once,
    // via `setPaintProperty` rather than inline in mapStyle.ts's static
    // layer literals (see that file's own citywide-cells-fill comment for
    // why the inline form doesn't type-check against this installed
    // @maplibre/maplibre-gl-style-spec version). citywide-cells-fill and
    // buildings-residential-hover are persisting-feature, feature-state-
    // driven hovers (the textbook transition case); the tile-highlight and
    // destination-preview trio use the SAME mechanism but rely on
    // withFadeFallback()'s persisting-feature trick (this file's own
    // comment) to have anything to transition FROM in the first place.
    // destination-* layers' own duration gets overwritten per-direction by
    // effect 10c below (entering vs. exiting) -- DESTINATION_ENTER_MS here
    // is just the sane starting default before that effect has ever run.
    map.setPaintProperty("citywide-cells-fill", "fill-opacity-transition", { duration: 160 });
    map.setPaintProperty("buildings-residential-hover", "fill-opacity-transition", { duration: 160 });
    map.setPaintProperty("tile-highlight-fill", "fill-opacity-transition", { duration: 200 });
    map.setPaintProperty("tile-highlight-outline", "line-opacity-transition", { duration: 200 });
    map.setPaintProperty("tile-highlight-points", "circle-opacity-transition", { duration: 200 });
    map.setPaintProperty("destination-rings-fill", "fill-opacity-transition", { duration: DESTINATION_ENTER_MS });
    map.setPaintProperty("destination-rings-outline", "line-opacity-transition", { duration: DESTINATION_ENTER_MS });
    map.setPaintProperty("destination-point", "circle-opacity-transition", { duration: DESTINATION_ENTER_MS });
    map.setPaintProperty("destination-point", "circle-radius-transition", { duration: DESTINATION_ENTER_MS });

    const onMoveEnd = () => updateLabelMarkers();

    // LAYOUT-V3 WAVE 1e: shows/replaces/clears the one per-building info
    // marker (buildBuildingInfoElement()'s own comment). Called from
    // onCitywideCellClick below, deliberately NOT its own independent
    // `map.on("click", "buildings-residential-hover", ...)` registration --
    // a residential building's footprint always sits inside some real cell,
    // so a second, separately-registered click listener on that layer would
    // ALSO fire for the exact same click, with no defined ordering between
    // it and this one (MapLibre fires every layer-scoped listener whose
    // geometry the click point intersects, in registration order, which
    // this codebase has no reason to depend on). More load-bearing than the
    // ordering risk alone: onCitywideCellClick's own comment below explains
    // a REAL bug this single-handler shape exists to prevent -- a building
    // click must short-circuit BEFORE the cell-swap path ever runs, not
    // just resolve independently of it.
    const showBuildingInfo = (feature: maplibregl.MapGeoJSONFeature | undefined, lngLat: LngLat) => {
      buildingInfoMarkerRef.current?.remove();
      buildingInfoMarkerRef.current = null;
      if (!feature) return;
      const props = feature.properties as {
        bbl: string | null;
        year_built: number | null;
        era: string | null;
        hazard_class_c: number | null;
      };
      const sources = geoRef.current?.sources ?? {};
      const el = buildBuildingInfoElement(
        {
          bbl: props.bbl,
          year_built: props.year_built,
          era: props.era as BuildingFeatureProps["era"],
          hazard_class_c: props.hazard_class_c,
        },
        { building_age: sources.building_age, hazards: sources.hazards },
        () => {
          buildingInfoMarkerRef.current?.remove();
          buildingInfoMarkerRef.current = null;
        },
      );
      buildingInfoMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(lngLat)
        .addTo(map);
    };

    // The click-to-load feature (SPEC-precompute-v2.md Phase 2): clicking
    // any real cell on the citywide grid swaps the report panel to that
    // cell. Registered on "citywide-cells-fill" -- a genuinely-transparent
    // fill layer (see mapStyle.ts's own comment) whose only job is
    // registering a hit anywhere inside a real block, not just within a
    // few pixels of an outline the way a line layer would.
    //
    // LAYOUT-V3 WAVE 1e: also checks whether the same click landed on a
    // residential building's own footprint (queried directly against
    // "buildings-residential-hover" -- see showBuildingInfo()'s own comment
    // for why this is a query here rather than a second registered
    // listener). A REAL bug found live via Playwright (not guessed, not a
    // test artifact -- browser console + a temporary debug log confirmed
    // the building hit WAS found and showBuildingInfo() WAS called, yet the
    // marker never stayed on screen): a building click must NOT also run
    // the "swap to a bare cell" path below, because App.tsx's
    // handleCellClick() unconditionally calls setSearchedAddress(null) --
    // which clears `address`, which clears `geo` (effect 4), which is
    // exactly the state effect 6's own cleanup watches to remove this very
    // marker. Every building sits inside some real cell, so without this
    // early return, EVERY building click would silently self-destruct its
    // own just-opened marker (and wipe the entire local building/street/
    // subway overlay along with it) one React render later. The fix: a
    // building click shows the building's record and returns, never
    // touching the cell-swap path or the currently searched address's own
    // overlay at all -- the user stays on the address they searched,
    // looking at one of its real buildings, exactly SPEC-layout-v3.md §8
    // Wave 1e's own intent.
    const onCitywideCellClick = (e: maplibregl.MapLayerMouseEvent) => {
      const buildingHit = map.queryRenderedFeatures(e.point, {
        layers: ["buildings-residential-hover"],
      })[0];
      if (buildingHit) {
        showBuildingInfo(buildingHit, e.lngLat);
        return;
      }

      const f = e.features?.[0];
      const h3id = f?.properties?.h3 as string | undefined;
      if (h3id) onCellClickRef.current(h3id);
      // Clicking anywhere that ISN'T a residential building (a different
      // block, empty street, water, etc.) closes whatever building record
      // was previously showing -- the same "clicking away closes it"
      // affordance a normal popup would have.
      showBuildingInfo(undefined, e.lngLat);
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

    // LAYOUT-V3 WAVE 1e: the same per-feature hover-state pattern as
    // onCitywideCellMove/onCitywideCellLeave above, scoped to
    // "buildings-residential-hover" instead -- a residential building gets
    // its own, stronger hover fill (mapStyle.ts's own comment) on top of
    // whatever the containing block's hover fill is already doing. No
    // separate cursor handling needed: "citywide-cells-fill" already covers
    // the whole city, so the cursor is already "pointer" everywhere this
    // building layer could ever be hovered.
    let hoveredBuildingFeatureId: number | null = null;
    const onBuildingMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const id = f?.id as number | undefined;
      if (id === undefined || id === hoveredBuildingFeatureId) return;
      if (hoveredBuildingFeatureId !== null) {
        map.setFeatureState({ source: "buildings", id: hoveredBuildingFeatureId }, { hover: false });
      }
      hoveredBuildingFeatureId = id;
      map.setFeatureState({ source: "buildings", id }, { hover: true });
    };
    const onBuildingLeave = () => {
      if (hoveredBuildingFeatureId !== null) {
        map.setFeatureState({ source: "buildings", id: hoveredBuildingFeatureId }, { hover: false });
        hoveredBuildingFeatureId = null;
      }
    };

    map.on("click", "citywide-cells-fill", onCitywideCellClick);
    map.on("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
    map.on("mousemove", "citywide-cells-fill", onCitywideCellMove);
    map.on("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
    map.on("mousemove", "buildings-residential-hover", onBuildingMove);
    map.on("mouseleave", "buildings-residential-hover", onBuildingLeave);
    map.on("moveend", onMoveEnd);

    return () => {
      map.off("click", "citywide-cells-fill", onCitywideCellClick);
      map.off("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
      map.off("mousemove", "citywide-cells-fill", onCitywideCellMove);
      map.off("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
      map.off("mousemove", "buildings-residential-hover", onBuildingMove);
      map.off("mouseleave", "buildings-residential-hover", onBuildingLeave);
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
      setReachLoading(false);
      return;
    }
    let cancelled = false;
    setReachLoading(true);
    getReach(address)
      .then((r) => {
        if (!cancelled) setReach(r);
      })
      .catch(() => {
        if (!cancelled) setReach(null);
      })
      .finally(() => {
        if (!cancelled) setReachLoading(false);
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
    if (!map || !mapReady) return;

    // LAYOUT-V3 WAVE 1e: whichever building info marker was open belonged
    // to the PREVIOUS `geo` fetch's own buildings source data -- a new
    // address search (or a failed/cleared one, `geo === null`) replaces
    // that data wholesale (new footprints, new feature ids, or none at
    // all), so any open marker is now pointing at a building that may no
    // longer exist at that id, or may exist but mean something different.
    // Closing it here (BEFORE the early-return below, so this also fires
    // when `geo` goes back to `null`) matches CellReportView's own "a new
    // block's report swaps in -- clear whatever hover/expand state the
    // PREVIOUS cell's tiles were in" rule, applied to this marker instead.
    buildingInfoMarkerRef.current?.remove();
    buildingInfoMarkerRef.current = null;

    if (!geo) return;

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

  // Last-real-geometry refs for the fade-rather-than-pop treatment
  // (withFadeFallback()'s own comment) -- one pair per faded source, since
  // each source's "last real shape" is independent of the others.
  const lastTileRegionRef = useRef<FeatureCollection | null>(null);
  const lastTilePointsRef = useRef<FeatureCollection | null>(null);
  const lastDestRingsRef = useRef<FeatureCollection | null>(null);
  const lastDestPointRef = useRef<FeatureCollection | null>(null);
  // Whether the destination preview was visible on the PREVIOUS run of
  // effect 10c -- lets that effect tell "just started showing" (enter, the
  // slower ~200ms ramp) apart from "just stopped showing" (exit, faster --
  // see that effect's own comment for the asymmetric-timing reasoning) so
  // it can set the map layers' own transition duration accordingly before
  // pushing the new (possibly now-faded) data.
  const destPreviewWasVisibleRef = useRef(false);

  // ---- 10b. push tile-highlight geometry whenever the hovered/expanded
  // side-panel tile changes (LAYOUT-V3 WAVE 1c item 4) -- see
  // tileHighlightGeometry()'s own comment for what each tile resolves to,
  // including the honest empty case for amenities with no `reach` loaded.
  //
  // MOTION WAVE (2026-08-03, item 3, "tile-highlight region... ease opacity
  // rather than snapping"): both sources are now wrapped in
  // withFadeFallback() so switching tiles (or losing hover entirely) fades
  // the PREVIOUS tile's real geometry out instead of it vanishing the
  // instant a different (or no) tile is hovered. Switching directly between
  // two DIFFERENT tiles that both have real geometry (e.g. crime's precinct
  // polygon -> noise's cell polygon) still repositions instantly, by
  // design -- see this wave's own report for why animating a distance-
  // bearing shape's POSITION is explicitly out of scope here (mapStyle.ts's
  // paint-property transitions only ever ease a persisting feature's
  // OPACITY, never interpolate its coordinates). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const { region, points } = tileHighlightGeometry(highlightedTile, {
      reach,
      citywide,
      selectedCell,
      crimePrecinct,
    });
    (map.getSource("tile-highlight-region") as maplibregl.GeoJSONSource | undefined)?.setData(
      withFadeFallback(region, lastTileRegionRef),
    );
    (map.getSource("tile-highlight-points") as maplibregl.GeoJSONSource | undefined)?.setData(
      withFadeFallback(points, lastTilePointsRef),
    );
    // WAVE 6b (2026-08-11): re-run the label pass immediately on every
    // highlightedTile change (not just on the next `moveend`) -- entering
    // or leaving the crime tile's hover must show/hide the police-area
    // labels (showPoliceLabelsRef, updated above on every render) right
    // away, not whenever the user next happens to pan or zoom the map.
    updateLabelMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedTile, reach, citywide, selectedCell, crimePrecinct, mapReady]);

  // ---- 10c. push the getting-around region's zone preview whenever the
  // hovered/selected destination changes (LAYOUT-V3 WAVE 3, SPEC-layout-
  // v3.md §5.3) -- three straight-line 5/10/15-minute rings plus a point,
  // centred on `destinationHighlight`, or all three sources cleared back to
  // empty when nothing is currently hovered/selected.
  //
  // HIGHLIGHT PRIORITY RULE (UX-FIX 2026-08-03, audit finding #3 -- "layered
  // map highlights compound into an illegible wall of red"). Two independent
  // systems can each put real, active red geometry on the map at the same
  // time: a side-panel tile hover (`highlightedTile`, effect 10b) and a
  // getting-around destination preview (`destinationHighlight`, this
  // effect). The audit's own repro combined a SELECTED (pinned, therefore
  // persistent -- see GettingAroundField's own comment on why "select"
  // deliberately outlives the cursor) destination's rings with an amenities-
  // tile hover's un-clustered point flood, on top of the always-on
  // searched-address reach rings -- three real red layers stacked with no
  // visual hierarchy between them.
  //
  // THE RULE: a live side-panel tile hover always outranks a destination
  // preview, because only one of the two can ever be a genuinely LIVE hover
  // at once (one cursor, two disjoint DOM regions -- CellReportView's own
  // tiles vs. GettingAroundField's own rows) -- so whenever `highlightedTile`
  // is non-null, it is unambiguously the newer, more specific "what is the
  // user pointing at right now" signal. The destination preview does NOT
  // disappear when outranked (a SELECTED destination must stay visible --
  // Wave 3's own "never silently absent" rule for a pinned place, which this
  // fix must not regress) -- it dims to a faint outline instead, via a real
  // `dimmed` property on every ring/point feature that mapStyle.ts's paint
  // expressions read (see buildDestinationPreviewLayers()'s own comment).
  // The rule is centralized here, in the one place both `highlightedTile`
  // and `destinationHighlight` already arrive as props, rather than patched
  // per-case in either CellReportView.tsx or GettingAroundField.tsx.
  //
  // The baseline/always-on preference-chip-driven reach-dots layer is
  // deliberately NOT part of this rule -- it's steady-state context a user
  // opted into (a chip toggle), not a momentary "what am I pointing at"
  // signal, so it keeps its own existing, already-low opacity regardless of
  // what else is highlighted. It's also painted in INK, not RED (see
  // buildReachLayers()'s own comment), so it never competes with the
  // red palette these two systems share in the
  // first place. ----
  //
  // MOTION WAVE (2026-08-03, item 3, "zone-preview fades/scales in (~200ms)
  // and out faster"): both sources go through withFadeFallback() (this
  // wave's fade-rather-than-pop mechanism -- see that function's own
  // comment) instead of collapsing straight to EMPTY_FC, and the map
  // layers' own `-transition` duration is set to a faster value right
  // before a genuinely EXITING data push (destinationHighlight just went
  // non-null -> null) than an ENTERING one -- MapLibre has no built-in
  // "different duration each direction" concept for a single `-transition`
  // config, so this is done by hand via setPaintProperty() immediately
  // before the setData() calls that trigger the transition, mirroring the
  // same asymmetry index.css's --motion-fast/--motion-base already give
  // the DOM-side anchor rows (GettingAroundField.tsx). Switching directly
  // between two DIFFERENT non-null destinations still repositions instantly
  // (same reasoning as effect 10b's own comment: no shape/position
  // interpolation, opacity-only).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const dimmed = highlightedTile !== null;
    // WAVE 4 (2026-08-11): a real route line and the straight-line zone
    // ring are never shown for the same destination at once (SPEC-layout-
    // v3.md Wave 4: "distinct visually and in copy from the zone preview")
    // -- GettingAroundField only ever sets `routeHighlight` for the SAME
    // point it also set `destinationHighlight` to, so a non-empty
    // `routeHighlight` here means "draw the real line instead," not "in
    // addition to."
    const routeLineShowing = routeHighlight !== null && routeHighlight.length > 0;
    const ringTarget = routeLineShowing ? null : destinationHighlight;
    const visible = ringTarget !== null;

    if (visible !== destPreviewWasVisibleRef.current) {
      const duration = visible ? DESTINATION_ENTER_MS : DESTINATION_EXIT_MS;
      map.setPaintProperty("destination-rings-fill", "fill-opacity-transition", { duration });
      map.setPaintProperty("destination-rings-outline", "line-opacity-transition", { duration });
      map.setPaintProperty("destination-point", "circle-opacity-transition", { duration });
      map.setPaintProperty("destination-point", "circle-radius-transition", { duration });
      destPreviewWasVisibleRef.current = visible;
    }

    (map.getSource("destination-rings") as maplibregl.GeoJSONSource | undefined)?.setData(
      withFadeFallback(destinationRingsGeoJSON(ringTarget, dimmed), lastDestRingsRef),
    );
    (map.getSource("destination-point") as maplibregl.GeoJSONSource | undefined)?.setData(
      withFadeFallback(destinationPointGeoJSON(ringTarget, dimmed), lastDestPointRef),
    );
    (map.getSource("route-line") as maplibregl.GeoJSONSource | undefined)?.setData(
      routeLineGeoJSON(geoRef.current, routeHighlight),
    );
  }, [destinationHighlight, routeHighlight, highlightedTile, mapReady, geo]);

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

    if (zoom >= 11 && showPoliceLabelsRef.current) {
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

  // LAYOUT-V3 WAVE 1d item 3 (2026-08-03, SPEC-layout-v3.md §8, cut pass):
  // the map legend (this file's own former `legend` useMemo + the
  // `.mapfield__legend` swatch row it fed) is gone outright, not relocated
  // -- every fact it spelled out (red dot = selected block, translucent
  // rings = walk-time bands, ink dots = nearby places) is already visible
  // on the map itself the moment it appears, and the map canvas's own
  // `aria-label` below still states the core "every block is clickable"
  // fact for anyone who can't see it rendered.
  //
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
          aria-label="Navigable map of New York City. Every real city block is clickable to load its record; homes and apartment buildings are clickable for their own year built and hazard record; shows building outlines, streets, subway lines, and walk-time rings for the selected address."
        />
        {/* UX-FIX 2026-08-03 (audit finding #1, "the map renders completely
            blank -- no basemap, no loading indicator -- for ~1.5-2s on every
            cold load"): `mapReady` (effect 1's own `map.on("load", ...)`)
            already existed as real state, it just wasn't rendered anywhere.
            No fake progress bar/percentage -- MapLibre gives no meaningful
            sub-steps to report before its own "load" event fires -- just an
            honest, already-established idiom (the same
            text+`.loading__dots` animated-ellipsis pattern App.tsx's own
            "Pulling the record" sidepanel placeholder uses) so a first-time
            visitor sees SOMETHING telling them the box is a map that's still
            arriving, not a broken/empty one. */}
        {!mapReady && (
          <div className="mapfield__loading" role="status">
            <span className="mapfield__loading-text mono">
              Loading the map<span className="loading__dots" aria-hidden="true" />
            </span>
          </div>
        )}
      </div>

      {/* LAYOUT-V3 WAVE 1d item 4 (2026-08-03, SPEC-layout-v3.md §8, Noah:
          "the Transit +3d control" -- precisely, this whole `.mapfield__
          controls` block, traced by reading this file, not guessed).
          Removed outright, not just the disabled "transit + 3d — coming
          soon" button: with that second lens gone, the remaining "Map
          view: [minimal]" row was a permanently-pressed, single-option
          toggle with nothing to switch to -- dead chrome by the same
          standard item 2's own cut pass applies ("does removing this make
          the next user action harder?" No: there was never a second real
          state to reach). The 3D-tilt lens (SPEC-layout-v3.md §6) stays
          deferred scope either way; this block returns with it if/when
          that lens ships. */}

      {/* WAVE 6e (2026-08-11, Noah live-use: "loading neighborhood record
          seems to take a long time"). Diagnosed, not guessed: this `loading`
          flag belongs to effect 4's own GET /api/map fetch (the map's local
          building/street overlay) -- the side-panel REPORT (CellReportView's
          tiles, driven by the separate, fast GET /api/cell/{h3}) is already
          fully loaded and interactive by the time this text can even appear
          (measured live via Playwright against this exact build: report
          tiles paint in ~100-360ms; /api/map itself measured 2.5-15.8s in
          the same run, consistent with the already-documented, already-
          flagged backend cost in the 2026-08-11 Wave 6c report -- a live
          bbox + per-cell metrics compute, not a frontend fetch-sequencing
          bug: App.tsx already fires the cell/map/reach requests essentially
          in parallel, confirmed in the same trace). The old copy ("Loading
          the neighborhood record...") named the wrong thing -- it read as
          if the whole report was still loading, when only this secondary
          map overlay was. Reworded to name what is ACTUALLY still loading,
          the same "loading the thing that's actually loading" fix Wave 6c
          already applied to the route-line preview's own note. */}
      {loading && <p className="mapfield__status mono">Loading this address's map detail…</p>}
      {error && <p className="mapfield__status mapfield__status--error mono">{error}</p>}

      {/* UX-FIX 2026-08-03 (audit finding #4, "amenities-tile hover has a
          silent race condition"): hovering the amenities tile within the
          first ~1-2s of a search -- before GET /api/reach has resolved --
          used to draw nothing on the map with no explanation at all
          (tileHighlightGeometry()'s own honest early-return for a tile with
          no real data yet). Rather than fabricate placeholder dots, this
          just says so -- the tile itself already has real data (it's
          `cell.amenities.counts`, a separate, already-loaded field), only
          the MAP's bonus point layer is still in flight. */}
      {highlightedTile === "amenities" && !reach && reachLoading && (
        <p className="mapfield__note mono">Loading nearby places to highlight on the map…</p>
      )}

      {/* WAVE 6c item 7 (2026-08-11, Noah: "route lines don't preview").
          REPRODUCED, then root-caused: the wiring (toggle -> hover ->
          GET /api/route -> onRouteHighlight -> this file's own route-line
          effect) is entirely correct -- confirmed live, the real line
          DOES draw, every time, once its one real dependency is ready.
          That dependency is `geo` (GET /api/map, this component's own
          local building/street/subway overlay -- `routeLineGeoJSON()`
          needs it to resolve a shape_id into real coordinates), and
          GET /api/map measured a consistent ~4-5s server-side response
          time on THIS machine across three repeated direct timed
          requests -- not a one-time cold-boot cost, a real per-request
          latency this endpoint has every time. `routeHighlight` itself
          comes from a SEPARATE, fast fetch (GET /api/route) with no such
          delay, so it very plausibly resolves to a real, non-empty
          shape_id array WHILE `geo` is still in flight -- exactly what a
          user toggling "Route lines: on" and immediately hovering a
          destination row hits. The existing `loading && "Loading the
          neighborhood record…"` message above already covers this window
          in principle, but says nothing about route lines specifically,
          and sits low in the map card, easy to not connect to a toggle
          and hover that both happened in the side panel. This note is the
          same fix precedent as the amenities-tile note just above it
          (2026-08-03 UX-fix wave, same root-cause SHAPE: a real, already-
          fetched-elsewhere UI action racing a second, independent,
          slower fetch) -- feature-specific, not a generic spinner. */}
      {loading && routeHighlight !== null && routeHighlight.length > 0 && (
        <p className="mapfield__note mono">
          Finding the real route line — still loading this address's street/transit detail…
        </p>
      )}

      {/* LAYOUT-V3 WAVE 1f item 5's own "ⓘ How this map is made" link (which
          used to live here, scoped to `geo || reach`) is gone as of WAVE 6
          (2026-08-11, SPEC-layout-v3.md §8) -- it was itself an instance of
          the chrome-that-varies-by-view this wave exists to remove (present
          only once a report had loaded, absent on a bare map). The app's
          one persistent shell (App.tsx) now carries a single, always-
          present "Methodology" link that reaches the exact same
          DisclosurePage.tsx destination, including this same "Reading the
          map" section (`geo.basemap_note`/`reach.method_note`/the
          destination-preview zone note all still live there verbatim,
          unchanged by this wave). */}
    </div>
  );
}
