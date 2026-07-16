import * as h3 from "h3-js";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import maplibregl, { type LngLat, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getCellsIndex, getCitywide, getMapGeometry } from "../api";
import { crimeRelativeLabel, formatPercentile, ordinalSuffix } from "../lib/crime";
import { buildMapStyle, buildOverlayLayers } from "../lib/mapStyle";
import { percentileRank } from "../lib/relativeScale";
import type { CellsIndexEntry, Citywide, MapCell, MapGeometry, Source } from "../types";
import { colorFor } from "./RouteBullet";

// VISUAL.md §5, REVISED 2026-07-15 -- MapLibre GL reading a self-hosted
// Protomaps PMTiles extract of NYC (bearings/sources/basemap.py bakes it;
// api.py serves it from this app's own /tiles origin, never a third-party
// tile server at request time). The base map (mapStyle.ts) is authored to
// this app's own palette; everything on top of it is real geometry from
// GET /api/map (the neighbourhood around the searched address -- building
// mass, street hairlines, subway/PATH, H3 noise cells) and GET /api/citywide
// (address-independent: NTA neighbourhood labels and every NYPD precinct's
// boundary + CompStat crime total, fetched once, not once per address).
//
// SPEC-precompute-v2.md Phase 2 (2026-07-15): the map is no longer gated
// behind a loaded report. It mounts immediately with GET /api/cells (every
// real H3 res-9 cell citywide, painted as a thin, always-on, CLICKABLE grid
// -- VISUAL.md §5's "the hex grid COVERS THE WHOLE CITY... any cell is
// clickable"), independent of whether `address` is set. `address` now only
// drives the local building/street/subway overlay for whichever address was
// actually searched -- it can be `null` (a bare cell click has no address),
// in which case that overlay is simply empty, never fetched, never blocking.

// Mirrors bearings/config.py's NYC_BBOX -- used ONLY to frame the initial
// view so the whole city is visible on first paint (VISUAL.md/the dispatch's
// own "grid visibly covers the whole city" check). This is NOT how "real
// cell" is decided (that stays the backend's data-derived job, see
// cellprofile.py's own module docstring) -- it is purely a camera bound.
const NYC_BBOX = { south: 40.47, north: 40.93, west: -74.30, east: -73.70 };

const INK = "#111111";
const RED = "#D7263D";
const STEEL = "#8A8D8F";

// The metric DROPDOWN (VISUAL.md §5, REVISED 2026-07-15), replacing the old
// hardcoded noise/crime toggle. "Shading the whole map needs a citywide
// value per area. Never fabricate a citywide surface" -- every entry here
// is triaged, honestly, into one of three buckets:
//   - "ship": a real, honestly-computed value backs every area shown.
//   - "proxy": a real value, but standing in for something this codebase
//     genuinely cannot compute (there is no citywide "commute time" --
//     a commute is always time to somewhere -- so transit_access offers
//     "how much real transit is within reach", named as access, not
//     commute) -- see mapgeo.py's own module docstring.
//   - "disabled": no honest citywide (or even honest per-cell-on-demand)
//     surface can be built -- shown greyed, with the real reason, never
//     silently hidden. Same rule this project already applies to NO_DATA
//     gaps elsewhere in the report.
type MetricStatus = "ship" | "proxy" | "disabled";
type MetricResolution = "cell" | "precinct" | "none";

interface MetricDef {
  id: string;
  label: string;
  resolution: MetricResolution;
  status: MetricStatus;
  cellField?: keyof MapCell;
  reason?: string; // only set (and only shown) for status === "disabled"
}

const METRICS: MetricDef[] = [
  { id: "none", label: "Off", resolution: "none", status: "ship" },
  { id: "noise", label: "Noise complaints", resolution: "cell", status: "ship", cellField: "noise" },
  { id: "crime", label: "Major crime (by police area)", resolution: "precinct", status: "ship" },
  {
    id: "amenities",
    label: "Grocery & everyday places",
    resolution: "cell",
    status: "ship",
    cellField: "amenities",
  },
  { id: "trees", label: "Living street trees", resolution: "cell", status: "ship", cellField: "trees" },
  {
    id: "building_age",
    label: "Building age (typical for the block)",
    resolution: "cell",
    status: "ship",
    cellField: "building_age_years",
  },
  {
    id: "transit_access",
    label: "Transit access (an estimate, not exact commute time)",
    resolution: "cell",
    status: "proxy",
    cellField: "transit_access",
  },
  {
    id: "flood",
    label: "Flood zone",
    resolution: "none",
    status: "disabled",
    reason:
      "The federal government's flood-risk map can only be checked one address at a time, and it fails on enough real requests that it isn't reliable enough to shade a whole map with.",
  },
  {
    id: "rodents",
    label: "Rodent inspections",
    resolution: "none",
    status: "disabled",
    reason:
      "Only inspected buildings show up in this data — a quiet-looking block could mean no rodents, or could just mean nobody filed a complaint there. There's no fair way to show this across the whole city yet.",
  },
  {
    id: "heat",
    label: "Heat / hot-water complaints",
    resolution: "none",
    status: "disabled",
    reason: "This is complaint data for individual buildings, not a full survey of every building — the same gap as the rodent data above.",
  },
  {
    id: "bedbugs",
    label: "Bedbug filings",
    resolution: "none",
    status: "disabled",
    reason: "Landlords file these once a year, and it's voluntary — no filing doesn't mean no bedbugs, just that nobody reported one.",
  },
];

// Label + unit for each cell metric's hover readout.
const CELL_METRIC_READOUT: Record<string, { label: string; unit: string }> = {
  noise: { label: "Noise complaints · last 12 months", unit: "calls" },
  amenities: { label: "Grocery & everyday places · in this block", unit: "places" },
  trees: { label: "Living street trees · in this block", unit: "trees" },
  building_age: { label: "Typical building year built", unit: "" },
  transit_access: { label: "Subway/PATH stations within ~6min walk", unit: "stations" },
};

function cellSourceFor(id: string, geo: MapGeometry | null): Source | undefined {
  if (!geo) return undefined;
  const key: Record<string, string> = {
    noise: "cells",
    amenities: "amenities",
    trees: "trees",
    building_age: "building_age",
    transit_access: "transit_access",
  };
  const sourceKey = key[id];
  return sourceKey ? geo.sources[sourceKey] : undefined;
}

// ---------------------------------------------------------------------------
// GeoJSON builders -- pure functions from the API contract to what MapLibre
// wants. GeoJSON is always [lng, lat]; every upstream field here (h3-js
// boundaries, MapGeometry coords, precinct geometry) is [lat, lng] like the
// rest of this codebase, so every builder below flips it once, here, rather
// than leaving that inversion to be rediscovered per-consumer.
// ---------------------------------------------------------------------------

// `cellField` is the currently-selected cell metric's raw field (or `null`
// when the metric picker is "Off", a precinct metric, or a disabled entry
// -- every cell then gets w=0/hasValue=0, so the fill layer's data-driven
// opacity naturally renders nothing without a separate visibility toggle).
//
// `w` is a PERCENTILE, not value/max (VISUAL.md §5: "Apply relative
// scaling ... to any metric where absolute counts would mislead, not just
// crime") -- computed via the same mean-rank method citywide.py's crime
// percentile uses, but ranked only against the other cells in this k=3
// disk (relativeScale.ts's own docstring states this distinction plainly:
// this is neighbourhood-relative, not citywide-relative like crime).
function cellsGeoJSON(geo: MapGeometry, cellField: keyof MapCell | null): FeatureCollection {
  const population = cellField
    ? geo.cells.map((c) => c[cellField]).filter((v): v is number => typeof v === "number")
    : [];
  const features: Feature[] = geo.cells.map((c) => {
    const boundary = h3.cellToBoundary(c.h3) as [number, number][]; // [lat, lng]
    const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]); // close the polygon ring
    const isSubject = c.h3 === geo.subject.cell;
    const raw = cellField ? c[cellField] : null;
    const hasValue = typeof raw === "number";
    const w = hasValue && population.length > 0 ? percentileRank(population, raw) / 100 : 0;
    return {
      type: "Feature",
      properties: {
        h3: c.h3,
        isSubject: isSubject ? 1 : 0,
        hasValue: hasValue ? 1 : 0,
        w,
        percentile: hasValue && population.length > 0 ? percentileRank(population, raw) : null,
        noise: c.noise,
        amenities: c.amenities,
        trees: c.trees,
        building_age_years: c.building_age_years,
        transit_access: c.transit_access,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });
  return { type: "FeatureCollection", features };
}

// The citywide clickable grid (mapStyle.ts's buildCitywideGridLayers()) --
// every real cell from GET /api/cells, as one GeoJSON polygon per cell.
// Deliberately carries NO per-feature metric value (`w`/`hasValue`, unlike
// cellsGeoJSON() below): this grid's job is navigation and click-to-load,
// not metric shading, so the only thing that ever varies its paint is
// SELECTION, toggled via MapLibre feature-state (see MapView's own
// selection effect) rather than rebuilding this FeatureCollection on every
// click -- cheap once, at data-load time, for ~7,000 features, rather than
// on every one of a user's clicks.
// `id` is the ARRAY INDEX, not the h3 string -- confirmed live (a small
// isolated MapLibre GL JS repro, not a guess): a GeoJSON feature's
// setFeatureState/getFeatureState bookkeeping accepts a string id fine
// (getFeatureState reports it back correctly), but the PAINT expression
// (`["feature-state", "selected"]` in mapStyle.ts) only actually picks up
// the state for a NUMERIC feature id on a GeoJSON source -- a string-id
// feature's state is stored but never rendered. This is exactly the class
// of thing that "only shows in a real render", not in `getFeatureState`'s
// own return value. `properties.h3` still carries the real h3 string
// (unaffected -- the click handler already reads it from there), so
// nothing downstream needs to know the numeric id exists except the
// selection effect's own h3->index lookup (built alongside this).
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

function precinctsGeoJSON(citywide: Citywide): FeatureCollection {
  // Crime is shaded RELATIVE to the rest of NYC, never on an absolute
  // scale (VISUAL.md §5, REVISED 2026-07-15): `w` used to be
  // total_ytd/maxCrime, which put nearly every precinct near the low end
  // of the ramp and only the single worst precinct at full colour --
  // exactly the "NYC just looks bad all around" failure the design brief
  // named. `crime_percentile` (bearings/citywide.py's percentile_rank(),
  // already baked into every precinct's crime block) is median-neutral by
  // construction, so reusing the SAME 0-1 fill-opacity ramp against
  // percentile/100 instead makes the median precinct read as the ramp's
  // own midpoint automatically, with no change to the ramp itself.
  return {
    type: "FeatureCollection",
    features: citywide.precincts.map((p) => ({
      type: "Feature",
      properties: {
        precinct: p.precinct,
        hasCrime: p.crime ? 1 : 0,
        w: p.crime ? p.crime.crime_percentile / 100 : 0,
        total_ytd: p.crime?.total_ytd ?? null,
        crime_percentile: p.crime?.crime_percentile ?? null,
        week_ending: p.crime?.week_ending ?? null,
      },
      geometry: p.geometry as unknown as Geometry,
    })),
  };
}

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

function roughDist(a: { lat: number; lng: number }, b: LngLat): number {
  // Not geodesic -- only ever used to rank on-screen labels by proximity
  // to the current view centre, where flat-Euclidean-on-degrees is fine.
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

// ---------------------------------------------------------------------------

interface HoveredCell {
  h3: string;
  isSubject: boolean;
  percentile: number | null;
  noise: number;
  amenities: number;
  trees: number;
  building_age_years: number | null;
  transit_access: number;
}

interface HoveredPrecinct {
  precinct: number;
  totalYtd: number | null;
  crimePercentile: number | null;
  weekEnding: string | null;
}

function formatCellValue(metricId: string, raw: number): string {
  if (metricId === "building_age") return String(Math.round(raw));
  return raw.toLocaleString();
}

function CellReadout({ cell, metric, source }: { cell: HoveredCell; metric: MetricDef; source?: Source }) {
  const info = CELL_METRIC_READOUT[metric.id];
  const raw = metric.cellField ? cell[metric.cellField] : null;
  return (
    <dl>
      <dt>{info?.label ?? metric.label}</dt>
      <dd>
        {typeof raw !== "number" ? (
          <span style={{ fontSize: 13, fontStyle: "italic", color: STEEL }}>NO DATA</span>
        ) : (
          <>
            {formatCellValue(metric.id, raw)}
            {info?.unit && <span style={{ fontSize: 11, color: STEEL, marginLeft: 6 }}>{info.unit}</span>}
          </>
        )}
      </dd>
      {cell.percentile !== null && (
        <>
          <dt>Relative to this neighbourhood</dt>
          <dd className="small">
            Ranks {Math.round(cell.percentile)}
            {ordinalSuffix(Math.round(cell.percentile))} out of 100 among the blocks shown here —
            not compared to the rest of the city.
          </dd>
        </>
      )}
      <dt>Area of this block</dt>
      <dd className="small">0.105 km²</dd>
      {cell.isSubject && (
        <>
          <dt>Status</dt>
          <dd className="small" style={{ color: RED }}>
            THIS ADDRESS&rsquo;S BLOCK
          </dd>
        </>
      )}
      {metric.status === "proxy" && (
        <>
          <dt>Note</dt>
          <dd className="small">
            An estimate, not an exact commute time — see the note above for what this measures.
          </dd>
        </>
      )}
      {source && (
        <>
          <dt>Source</dt>
          <dd className="small">{source.name}</dd>
        </>
      )}
    </dl>
  );
}

function PrecinctReadout({
  precinct,
  source,
  caveat,
}: {
  precinct: HoveredPrecinct;
  source?: { name: string; url: string };
  caveat?: string;
}) {
  return (
    <dl>
      <dt>Police area</dt>
      <dd>{precinct.precinct}</dd>
      <dt>Crime here, compared to the city</dt>
      <dd>
        {precinct.crimePercentile === null ? (
          <span style={{ fontSize: 13, fontStyle: "italic", color: STEEL }}>NO DATA</span>
        ) : (
          crimeRelativeLabel(precinct.crimePercentile)
        )}
      </dd>
      {precinct.crimePercentile !== null && (
        <>
          <dt>Rank · crimes so far this year</dt>
          <dd className="small">
            {formatPercentile(precinct.crimePercentile)} · {precinct.totalYtd?.toLocaleString()} major
            crimes so far this year
          </dd>
        </>
      )}
      {precinct.weekEnding && (
        <>
          <dt>Week ending</dt>
          <dd className="small">{precinct.weekEnding}</dd>
        </>
      )}
      {source && (
        <>
          <dt>Source</dt>
          <dd className="small">{source.name}</dd>
        </>
      )}
      {caveat && (
        <>
          <dt>Note</dt>
          <dd className="small">{caveat}</dd>
        </>
      )}
    </dl>
  );
}

export function MapView({
  address,
  selectedCell,
  onCellClick,
}: {
  // The real searched address, or `null` when the current selection came
  // from a bare grid click (no address) -- drives ONLY the local building/
  // street/subway overlay fetch (GET /api/map) below, never the citywide
  // grid itself, which is address-independent.
  address: string | null;
  // The h3 id currently driving the report panel (App.tsx owns this) --
  // used to fly the camera there and to emphasize that cell on the
  // citywide grid, regardless of whether it came from a click or a search.
  selectedCell: string | null;
  // Fired when the user clicks any real cell on the citywide grid -- the
  // "click any hex to swap the report" feature (SPEC-precompute-v2.md
  // Phase 2). App.tsx owns what happens next (GET /api/cell/{h3}).
  onCellClick: (h3: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [citywide, setCitywide] = useState<Citywide | null>(null);
  const citywideRef = useRef<Citywide | null>(null);
  citywideRef.current = citywide;

  // The citywide grid's own data (GET /api/cells) -- fetched exactly once
  // on mount, independent of `address`/`selectedCell`, so the grid covers
  // the whole city before any search or click ever happens.
  const [cellsIndex, setCellsIndex] = useState<CellsIndexEntry[] | null>(null);

  // h3 string -> the NUMERIC feature id citywideCellsGeoJSON() assigned it
  // (its array index) -- see that function's own comment for why the
  // selection effect (10 below) needs this rather than addressing
  // setFeatureState with the h3 string directly.
  const h3ToFeatureId = useMemo(() => {
    const m = new Map<string, number>();
    cellsIndex?.forEach((c, i) => m.set(c.h3, i));
    return m;
  }, [cellsIndex]);

  const [metricId, setMetricId] = useState<string>("none");
  const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null);
  const [hoveredPrecinct, setHoveredPrecinct] = useState<HoveredPrecinct | null>(null);

  const labelMarkersRef = useRef<Marker[]>([]);
  const stationMarkersRef = useRef<Marker[]>([]);

  // Always-current ref for the click callback -- effect 2 (below) registers
  // its MapLibre click listener exactly once per `mapReady` transition, not
  // once per render, so calling `onCellClick` directly from inside that
  // closure would capture whatever value it had the moment the listener was
  // added and never see a newer one App.tsx passes down on a later render.
  const onCellClickRef = useRef(onCellClick);
  onCellClickRef.current = onCellClick;

  // The NUMERIC feature id this component itself last marked
  // `selected: true` -- so the selection effect (10 below) can clear the
  // PREVIOUS cell's highlight without clearing every other cell's state
  // (there is no "clear all feature state" primitive that wouldn't also be
  // real, avoidable work across ~7,000 features).
  const prevSelectedFeatureIdRef = useRef<number | null>(null);

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
      // The whole city visible on first paint (the dispatch's own "grid
      // visibly covers the whole city" check) -- a real bounds fit, not a
      // guessed center/zoom pair. `selectedCell`'s own flyTo effect (8
      // below) takes over once a real location is searched or clicked.
      bounds: [
        [NYC_BBOX.west, NYC_BBOX.south],
        [NYC_BBOX.east, NYC_BBOX.north],
      ],
      fitBoundsOptions: { padding: 20 },
      minZoom: 9,
      maxZoom: 18,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("load", () => setMapReady(true));

    return () => {
      labelMarkersRef.current.forEach((m) => m.remove());
      labelMarkersRef.current = [];
      stationMarkersRef.current.forEach((m) => m.remove());
      stationMarkersRef.current = [];
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
    // (effects 5/6/7 below) once real geometry has actually loaded; empty
    // here so the layers below have something to attach to at init.
    map.addSource("precincts", { type: "geojson", data: EMPTY_FC });
    map.addSource("buildings", { type: "geojson", data: EMPTY_FC });
    map.addSource("streets", { type: "geojson", data: EMPTY_FC });
    map.addSource("subway", { type: "geojson", data: EMPTY_FC });
    map.addSource("cells", { type: "geojson", data: EMPTY_FC });
    // The citywide clickable grid's source (populated by effect 6 below,
    // once GET /api/cells resolves) -- `promoteId` is unnecessary here
    // since citywideCellsGeoJSON() already sets each Feature's own real
    // `id` (the h3 string), which is exactly what MapLibre's
    // setFeatureState({source, id}) addresses.
    map.addSource("citywide-cells", { type: "geojson", data: EMPTY_FC });

    // The actual layer definitions (paint/layout/filter) live in
    // mapStyle.ts's buildOverlayLayers(), as a pure/exported function so
    // this exact layer set is unit-testable with MapLibre's real style
    // validator (mapStyle.test.ts) -- see that function's own comment for
    // the 2026-07-15 "zoom expression nested, not top-level" bug this
    // extraction guards against.
    for (const layer of buildOverlayLayers()) {
      map.addLayer(layer);
    }

    const onCellMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f?.properties) return;
      map.getCanvas().style.cursor = "crosshair";
      setHoveredCell({
        h3: f.properties.h3 as string,
        isSubject: f.properties.isSubject === 1,
        percentile: (f.properties.percentile as number | null) ?? null,
        noise: f.properties.noise as number,
        amenities: f.properties.amenities as number,
        trees: f.properties.trees as number,
        building_age_years: (f.properties.building_age_years as number | null) ?? null,
        transit_access: f.properties.transit_access as number,
      });
    };
    const onCellLeave = () => {
      map.getCanvas().style.cursor = "";
      setHoveredCell(null);
    };
    const onPrecinctMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f?.properties) return;
      map.getCanvas().style.cursor = "crosshair";
      setHoveredPrecinct({
        precinct: f.properties.precinct as number,
        totalYtd: (f.properties.total_ytd as number | null) ?? null,
        crimePercentile: (f.properties.crime_percentile as number | null) ?? null,
        weekEnding: (f.properties.week_ending as string | null) ?? null,
      });
    };
    const onPrecinctLeave = () => {
      map.getCanvas().style.cursor = "";
      setHoveredPrecinct(null);
    };
    const onMoveEnd = () => updateLabelMarkers();

    // The click-to-load feature (SPEC-precompute-v2.md Phase 2): clicking
    // any real cell on the citywide grid swaps the report panel to that
    // cell. Registered on "citywide-cells-fill" -- a genuinely-transparent
    // fill layer (see mapStyle.ts's own comment) whose only job is
    // registering a hit anywhere inside a hex, not just within a few
    // pixels of its outline the way a line layer would.
    const onCitywideCellClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const h3id = f?.properties?.h3 as string | undefined;
      if (h3id) onCellClickRef.current(h3id);
    };
    const onCitywideCellEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onCitywideCellLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("mousemove", "cells-fill", onCellMove);
    map.on("mouseleave", "cells-fill", onCellLeave);
    map.on("mousemove", "precinct-fill", onPrecinctMove);
    map.on("mouseleave", "precinct-fill", onPrecinctLeave);
    map.on("click", "citywide-cells-fill", onCitywideCellClick);
    map.on("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
    map.on("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
    map.on("moveend", onMoveEnd);

    return () => {
      map.off("mousemove", "cells-fill", onCellMove);
      map.off("mouseleave", "cells-fill", onCellLeave);
      map.off("mousemove", "precinct-fill", onPrecinctMove);
      map.off("mouseleave", "precinct-fill", onPrecinctLeave);
      map.off("click", "citywide-cells-fill", onCitywideCellClick);
      map.off("mouseenter", "citywide-cells-fill", onCitywideCellEnter);
      map.off("mouseleave", "citywide-cells-fill", onCitywideCellLeave);
      map.off("moveend", onMoveEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // ---- 3. fetch the citywide grid's own data exactly once, independent
  // of any address/selection -- this is what lets the grid cover the whole
  // city before any search or click happens (VISUAL.md §5, REVISED
  // 2026-07-15). Non-fatal on failure: the map/basemap/report flow all
  // still work without the grid, it just quietly has no clickable overlay.
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
  // grid click (Task 4: this must never block the citywide grid or the
  // report panel, both of which are already interactive by the time this
  // starts, still 18-24s slow per Phase 1's measured baseline; see
  // api.py's get_map() docstring for the Phase 2b follow-up this is
  // waiting on). ----
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
    setHoveredCell(null);
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

  // ---- 5. fetch citywide (address-independent) label/crime data once. ----
  useEffect(() => {
    let cancelled = false;
    getCitywide()
      .then((c) => {
        if (!cancelled) setCitywide(c);
      })
      .catch(() => {
        // Non-fatal: the map still works without labels/the crime
        // choropleth -- it just quietly has fewer layers, never a crash.
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
    (map.getSource("precincts") as maplibregl.GeoJSONSource | undefined)?.setData(precinctsGeoJSON(citywide));
    updateLabelMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citywide, mapReady]);

  // ---- 8. metric picker: recompute the cell percentiles for whichever
  // metric is selected, and toggle the precinct choropleth's visibility.
  // cells-fill's paint expression (effect 2) is static -- it already reads
  // per-feature `hasValue`/`w`, which is what changes here, not the
  // expression itself.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geo) return;
    const active = METRICS.find((m) => m.id === metricId);
    const cellField = active?.resolution === "cell" ? (active.cellField ?? null) : null;
    (map.getSource("cells") as maplibregl.GeoJSONSource | undefined)?.setData(cellsGeoJSON(geo, cellField));

    const precinctVisible = active?.resolution === "precinct" ? "visible" : "none";
    map.setLayoutProperty("precinct-fill", "visibility", precinctVisible);
    map.setLayoutProperty("precinct-outline", "visibility", precinctVisible);
  }, [metricId, geo, mapReady]);

  // ---- 9. push the citywide grid's own data into the map once it's
  // loaded (independent of mapReady/data ordering -- whichever resolves
  // second triggers this). ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !cellsIndex) return;
    (map.getSource("citywide-cells") as maplibregl.GeoJSONSource | undefined)?.setData(
      citywideCellsGeoJSON(cellsIndex),
    );
  }, [cellsIndex, mapReady]);

  // ---- 10. emphasize whichever cell is currently driving the report
  // panel on the citywide grid, via MapLibre feature-state (not a
  // GeoJSON rebuild -- see citywideCellsGeoJSON()'s own comment), using
  // the cell's NUMERIC feature id (h3ToFeatureId), not its h3 string --
  // see citywideCellsGeoJSON()'s own comment for the confirmed-live
  // MapLibre GL JS limitation this works around. Also depends on
  // `cellsIndex`/`h3ToFeatureId` (not just `selectedCell`/`mapReady`): a
  // search can resolve a cell before GET /api/cells has finished loading,
  // and feature-state set before a feature exists needs re-applying once
  // it does -- this re-run is what closes that race, and it's a harmless
  // no-op the rest of the time. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const prevId = prevSelectedFeatureIdRef.current;
    const nextId = selectedCell ? h3ToFeatureId.get(selectedCell) : undefined;
    if (prevId !== null && prevId !== undefined && prevId !== nextId) {
      map.setFeatureState({ source: "citywide-cells", id: prevId }, { selected: false });
    }
    if (nextId !== undefined) {
      map.setFeatureState({ source: "citywide-cells", id: nextId }, { selected: true });
    }
    prevSelectedFeatureIdRef.current = nextId ?? null;
  }, [selectedCell, mapReady, cellsIndex, h3ToFeatureId]);

  // ---- 11. fly the camera to whichever cell is selected -- computed
  // straight from the real h3 id via h3-js's own cellToLatLng(), so this
  // never has to wait on GET /api/cells or GET /api/map to know where to
  // go (Task 4: the map must stay responsive even while the slower local
  // overlay is still loading). ----
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

    // Level-of-detail by zoom (VISUAL.md §5): "Zoomed out (city): ...
    // neighbourhood labels [visible]" -- neighbourhood names are the
    // city-scale orientation label, so they appear near this map's own
    // minZoom (9); precinct numbers are a finer, more technical label and
    // only resolve in once you're already zoomed past city scale. 262
    // neighbourhoods and 78 precinct numbers rendered unconditionally
    // citywide would be unreadable clutter at any zoom either way, so both
    // are still capped to the nearest N actually inside the current view
    // (DOM markers, not GPU-rendered symbols, so an unbounded count would
    // also be a real perf cost).
    if (zoom >= 9.5) {
      const visible = cw.neighborhoods
        .filter((n) => bounds.contains([n.lng, n.lat]))
        .sort((a, b) => roughDist(a, center) - roughDist(b, center))
        .slice(0, 40);
      for (const n of visible) {
        const el = document.createElement("div");
        el.className = "maplabel maplabel--neighborhood";
        el.textContent = n.name;
        labelMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([n.lng, n.lat]).addTo(map),
        );
      }
    }

    if (zoom >= 11) {
      const visible = cw.precincts
        .filter((p) => bounds.contains([p.lng, p.lat]))
        .sort((a, b) => roughDist(a, center) - roughDist(b, center))
        .slice(0, 30);
      for (const p of visible) {
        const el = document.createElement("div");
        el.className = "maplabel maplabel--precinct";
        el.textContent = `Police area ${p.precinct}`;
        labelMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map),
        );
      }
    }
  }

  const activeMetric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const cellMetricSource = cellSourceFor(metricId, geo);
  const crimeSource = citywide?.crime_source;
  const crimeCaveat = citywide?.crime_caveat;

  const activeCellReadout = activeMetric.resolution === "cell" && hoveredCell;
  const activePrecinctReadout = activeMetric.resolution === "precinct" && hoveredPrecinct;

  const legend = useMemo(
    () => [
      {
        swatch: { border: `1px solid ${INK}`, background: "none", opacity: 0.4 },
        label: "Every real city block · click any one to see its record",
      },
      ...(geo
        ? [
            { swatch: { background: STEEL, opacity: 0.34 }, label: "Buildings" },
            { swatch: { background: INK, height: 2 }, label: "Streets, by size" },
            { swatch: { background: RED }, label: "Subway & PATH lines" },
          ]
        : []),
      {
        swatch: { border: `1px solid ${RED}`, background: "none" },
        label: "The selected block · about 0.105 km²",
      },
      ...(activeMetric.resolution === "precinct"
        ? [
            {
              swatch: { background: RED, opacity: 0.34 },
              label: "Crime shading · compared with the rest of NYC, an average area is neutral",
            },
          ]
        : []),
      ...(activeMetric.resolution === "cell" && activeMetric.id !== "none"
        ? [
            {
              swatch: { background: RED, opacity: 0.34 },
              label: `${activeMetric.label} · relative to the surrounding blocks`,
            },
          ]
        : []),
    ],
    [activeMetric, geo],
  );

  return (
    <div className="mapfield">
      <h2 className="field__title">The neighbourhood, navigable</h2>

      <div className="mapfield__controls">
        <label htmlFor="mapfield-metric">Shade the map by</label>
        <select
          id="mapfield-metric"
          className="mapfield__select"
          value={metricId}
          onChange={(e) => setMetricId(e.target.value)}
        >
          {METRICS.map((m) => (
            <option key={m.id} value={m.id} disabled={m.status === "disabled"} title={m.reason}>
              {m.label}
              {m.status === "disabled" ? " — greyed, see note below" : ""}
            </option>
          ))}
        </select>
        {activeMetric.status === "proxy" && (
          <span className="mapfield__metricnote small">An estimate, not an exact commute time.</span>
        )}
      </div>
      {METRICS.some((m) => m.status === "disabled") && (
        <p className="mapfield__note mono">
          Greyed-out options don&rsquo;t have reliable data for the whole city yet — hover one for
          the real reason.
        </p>
      )}

      <div className="mapfield__stage">
        <div>
          <div className="mapfield__frame">
            <div
              ref={containerRef}
              className="mapfield__map"
              role="img"
              aria-label="Navigable map of all of New York City, with every real city block outlined and clickable to load its own record, plus real building outlines, streets, and subway lines around whichever address or block is currently selected"
            />
          </div>
          <div className="mapfield__legend">
            {legend.map((item, i) => (
              <span key={i}>
                <i style={item.swatch} />
                {item.label}
              </span>
            ))}
          </div>
          {loading && <p className="mapfield__status mono">Loading the neighbourhood record…</p>}
          {error && <p className="mapfield__status mapfield__status--error mono">{error}</p>}
        </div>

        <div className="readout">
          <h3>What&rsquo;s here</h3>
          {activeCellReadout ? (
            <CellReadout cell={hoveredCell} metric={activeMetric} source={cellMetricSource} />
          ) : activePrecinctReadout ? (
            <PrecinctReadout precinct={hoveredPrecinct} source={crimeSource} caveat={crimeCaveat} />
          ) : (
            <p className="readout__empty">
              Hover a block{citywide ? " or area" : ""}.
              <br />
              <br />
              Pan and zoom freely — the map covers all of New York City, and every real block is
              outlined. Click any block to load its own record, or search an address above.
            </p>
          )}
        </div>
      </div>

      {geo && <p className="mapfield__note mono">{geo.basemap_note}</p>}
      {activeMetric.resolution === "precinct" && crimeCaveat && (
        <p className="mapfield__note mono">{crimeCaveat}</p>
      )}
    </div>
  );
}
