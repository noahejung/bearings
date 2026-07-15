import * as h3 from "h3-js";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import maplibregl, { type LngLat, type Map as MapLibreMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getCitywide, getMapGeometry } from "../api";
import { crimeRelativeLabel, formatPercentile } from "../lib/crime";
import { buildMapStyle } from "../lib/mapStyle";
import type { Citywide, MapGeometry } from "../types";
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

const INK = "#111111";
const RED = "#D7263D";
const STEEL = "#8A8D8F";

type HeatMode = "none" | "noise" | "crime";

const HEAT_MODES: { id: HeatMode; label: string }[] = [
  { id: "none", label: "Off" },
  { id: "noise", label: "311 noise (per cell)" },
  { id: "crime", label: "CompStat crime (per precinct)" },
];

// ---------------------------------------------------------------------------
// GeoJSON builders -- pure functions from the API contract to what MapLibre
// wants. GeoJSON is always [lng, lat]; every upstream field here (h3-js
// boundaries, MapGeometry coords, precinct geometry) is [lat, lng] like the
// rest of this codebase, so every builder below flips it once, here, rather
// than leaving that inversion to be rediscovered per-consumer.
// ---------------------------------------------------------------------------

function cellsGeoJSON(geo: MapGeometry): FeatureCollection {
  const maxValue = Math.max(1, ...geo.cells.map((c) => c.value));
  const features: Feature[] = geo.cells.map((c) => {
    const boundary = h3.cellToBoundary(c.h3) as [number, number][]; // [lat, lng]
    const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
    ring.push(ring[0]); // close the polygon ring
    const isSubject = c.h3 === geo.subject.cell;
    return {
      type: "Feature",
      properties: { h3: c.h3, value: c.value, isSubject: isSubject ? 1 : 0, w: c.value / maxValue },
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
  value: number;
  isSubject: boolean;
}

interface HoveredPrecinct {
  precinct: number;
  totalYtd: number | null;
  crimePercentile: number | null;
  weekEnding: string | null;
}

function CellReadout({ cell, source }: { cell: HoveredCell; source?: { name: string; url: string } }) {
  return (
    <dl>
      <dt>311 noise · trailing 12mo</dt>
      <dd>
        {cell.value}
        <span style={{ fontSize: 11, color: STEEL, marginLeft: 6 }}>calls</span>
      </dd>
      <dt>Cell area</dt>
      <dd className="small">0.105 km²</dd>
      {cell.isSubject && (
        <>
          <dt>Status</dt>
          <dd className="small" style={{ color: RED }}>
            SUBJECT CELL
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
      <dt>NYPD Precinct</dt>
      <dd>{precinct.precinct}</dd>
      <dt>Major crime, citywide</dt>
      <dd>
        {precinct.crimePercentile === null ? (
          <span style={{ fontSize: 13, fontStyle: "italic", color: STEEL }}>NO DATA</span>
        ) : (
          crimeRelativeLabel(precinct.crimePercentile)
        )}
      </dd>
      {precinct.crimePercentile !== null && (
        <>
          <dt>Percentile · YTD count</dt>
          <dd className="small">
            {formatPercentile(precinct.crimePercentile)} · {precinct.totalYtd?.toLocaleString()} major
            crimes YTD
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

export function MapView({ address }: { address: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [citywide, setCitywide] = useState<Citywide | null>(null);
  const citywideRef = useRef<Citywide | null>(null);
  citywideRef.current = citywide;

  const [heatMode, setHeatMode] = useState<HeatMode>("none");
  const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null);
  const [hoveredPrecinct, setHoveredPrecinct] = useState<HoveredPrecinct | null>(null);

  const labelMarkersRef = useRef<Marker[]>([]);
  const stationMarkersRef = useRef<Marker[]>([]);

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
      center: [-73.9857, 40.7484], // Manhattan-ish, replaced by the first real address's bbox
      zoom: 10.5,
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

    map.addSource("precincts", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
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
    });
    map.addLayer({
      id: "precinct-outline",
      type: "line",
      source: "precincts",
      layout: { visibility: "none" },
      paint: { "line-color": INK, "line-width": 0.6, "line-opacity": 0.5 },
    });

    map.addSource("buildings", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "buildings-fill",
      type: "fill",
      source: "buildings",
      paint: { "fill-color": STEEL, "fill-opacity": 0.34 },
    });

    map.addSource("streets", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "streets-line",
      type: "line",
      source: "streets",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": INK,
        "line-width": ["match", ["get", "rank"], 0, 0.6, 1, 0.9, 2, 1.4, 3, 2.0, 0.6],
        "line-opacity": ["match", ["get", "rank"], 0, 0.35, 1, 0.55, 2, 0.75, 3, 0.9, 0.35],
      },
    });

    map.addSource("subway", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "subway-line",
      type: "line",
      source: "subway",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": RED, "line-width": 2.4, "line-opacity": 0.92 },
    });

    // The H3 disk is the only STRONG ink on the sheet (VISUAL.md §5) --
    // thin outline (Noah, 2026-07-15: reduce stroke weight), subject cell
    // red. Fill only carries a value when the noise heat-map is selected.
    map.addSource("cells", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "cells-fill",
      type: "fill",
      source: "cells",
      paint: {
        "fill-color": RED,
        "fill-opacity": [
          "case",
          ["==", ["get", "isSubject"], 1],
          0,
          ["interpolate", ["linear"], ["get", "w"], 0, 0.05, 1, 0.55],
        ],
      },
    });
    map.addLayer({
      id: "cells-outline",
      type: "line",
      source: "cells",
      paint: {
        "line-color": ["case", ["==", ["get", "isSubject"], 1], RED, INK],
        "line-width": ["case", ["==", ["get", "isSubject"], 1], 1.6, 0.6],
        "line-opacity": ["case", ["==", ["get", "isSubject"], 1], 1, 0.45],
      },
    });

    const onCellMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f?.properties) return;
      map.getCanvas().style.cursor = "crosshair";
      setHoveredCell({
        h3: f.properties.h3 as string,
        value: f.properties.value as number,
        isSubject: f.properties.isSubject === 1,
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

    map.on("mousemove", "cells-fill", onCellMove);
    map.on("mouseleave", "cells-fill", onCellLeave);
    map.on("mousemove", "precinct-fill", onPrecinctMove);
    map.on("mouseleave", "precinct-fill", onPrecinctLeave);
    map.on("moveend", onMoveEnd);

    return () => {
      map.off("mousemove", "cells-fill", onCellMove);
      map.off("mouseleave", "cells-fill", onCellLeave);
      map.off("mousemove", "precinct-fill", onPrecinctMove);
      map.off("mouseleave", "precinct-fill", onPrecinctLeave);
      map.off("moveend", onMoveEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // ---- 3. fetch the neighbourhood around the searched address. ----
  useEffect(() => {
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

  // ---- 4. fetch citywide (address-independent) data once. ----
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

  // ---- 5. push the address-scoped geometry into the map + fly to it. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geo) return;

    (map.getSource("cells") as maplibregl.GeoJSONSource | undefined)?.setData(cellsGeoJSON(geo));
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

  // ---- 6. push citywide geometry into the map + refresh labels. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !citywide) return;
    (map.getSource("precincts") as maplibregl.GeoJSONSource | undefined)?.setData(precinctsGeoJSON(citywide));
    updateLabelMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citywide, mapReady]);

  // ---- 7. heat-map toggle: which choropleth (if any) is visible. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const precinctVisible = heatMode === "crime" ? "visible" : "none";
    map.setLayoutProperty("precinct-fill", "visibility", precinctVisible);
    map.setLayoutProperty("precinct-outline", "visibility", precinctVisible);
    map.setPaintProperty(
      "cells-fill",
      "fill-opacity",
      heatMode === "noise"
        ? ["case", ["==", ["get", "isSubject"], 1], 0, ["interpolate", ["linear"], ["get", "w"], 0, 0.05, 1, 0.55]]
        : 0,
    );
  }, [heatMode, mapReady]);

  function updateLabelMarkers() {
    const map = mapRef.current;
    const cw = citywideRef.current;
    if (!map || !cw) return;

    labelMarkersRef.current.forEach((m) => m.remove());
    labelMarkersRef.current = [];

    const bounds = map.getBounds();
    const center = map.getCenter();
    const zoom = map.getZoom();

    // Thin labels by zoom, the way every real web map does -- 262
    // neighbourhoods and 78 precinct numbers rendered unconditionally
    // citywide would be unreadable clutter at a zoomed-out view and a
    // real perf cost (DOM markers, not GPU-rendered symbols).
    if (zoom >= 11) {
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

    if (zoom >= 10) {
      const visible = cw.precincts
        .filter((p) => bounds.contains([p.lng, p.lat]))
        .sort((a, b) => roughDist(a, center) - roughDist(b, center))
        .slice(0, 30);
      for (const p of visible) {
        const el = document.createElement("div");
        el.className = "maplabel maplabel--precinct";
        el.textContent = `Precinct ${p.precinct}`;
        labelMarkersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map),
        );
      }
    }
  }

  const noiseSource = geo?.sources.cells;
  const crimeSource = citywide?.crime_source;
  const crimeCaveat = citywide?.crime_caveat;

  const activeCellReadout = heatMode !== "crime" && hoveredCell;
  const activePrecinctReadout = heatMode === "crime" && hoveredPrecinct;

  const legend = useMemo(
    () => [
      { swatch: { background: STEEL, opacity: 0.34 }, label: "Building footprint" },
      { swatch: { background: INK, height: 2 }, label: "Street, by road class" },
      { swatch: { background: RED }, label: "Subway / PATH — real alignment" },
      {
        swatch: { border: `1px solid ${INK}`, background: "none" },
        label: "H3 res-9 cell · 0.105 km² · subject in red",
      },
      ...(heatMode === "crime"
        ? [
            {
              swatch: { background: RED, opacity: 0.34 },
              label: "Precinct fill · percentile vs. NYC, median neutral",
            },
          ]
        : []),
    ],
    [heatMode],
  );

  return (
    <div className="mapfield">
      <h2 className="field__title">The neighbourhood, navigable</h2>

      <div className="mapfield__controls">
        <span>Heat-map</span>
        {HEAT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="mapfield__toggle"
            aria-pressed={heatMode === m.id}
            onClick={() => setHeatMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="mapfield__stage">
        <div>
          <div className="mapfield__frame">
            <div
              ref={containerRef}
              className="mapfield__map"
              role="img"
              aria-label="Navigable map of New York City, centred on the neighbourhood around the searched address, with real building footprints, streets, subway alignments, and H3 noise cells"
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
          <h3>Map readout</h3>
          {activeCellReadout ? (
            <CellReadout cell={hoveredCell} source={noiseSource} />
          ) : activePrecinctReadout ? (
            <PrecinctReadout precinct={hoveredPrecinct} source={crimeSource} caveat={crimeCaveat} />
          ) : (
            <p className="readout__empty">
              Hover a cell{citywide ? " or precinct" : ""}.
              <br />
              <br />
              Pan and zoom the map freely — the base layer covers all of NYC. The
              highlighted neighbourhood is the one around your searched address.
            </p>
          )}
        </div>
      </div>

      {geo && <p className="mapfield__note mono">{geo.basemap_note}</p>}
      {heatMode === "crime" && crimeCaveat && <p className="mapfield__note mono">{crimeCaveat}</p>}
    </div>
  );
}
