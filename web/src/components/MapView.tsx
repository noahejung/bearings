import * as h3 from "h3-js";
import { useEffect, useMemo, useState } from "react";
import { ApiError, getMapGeometry } from "../api";
import type { MapCell, MapGeometry } from "../types";

// VISUAL.md §5 -- self-drawn vectors, no map library, no tile server, no
// live third-party basemap call in the request path. Ported from the
// Noah-approved prototype (scratchpad/bearings-map.html, base=hybrid,
// texture=stipple). Every layer is real geometry: NYC building footprints
// and street centrelines (baked at build time -- sources/buildings.py,
// sources/streets.py), GTFS subway/PATH alignments, and real H3 cell
// boundaries (h3-js cellToBoundary) with real 311-derived density.

const BONE = "#EDE9DE";
const INK = "#111111";
const STEEL = "#8A8D8F";
const RED = "#D7263D";

const VB_W = 860;
const VB_H = 560;

// One-line toggle (VISUAL.md §6, "cheap to flip either way"): whether the
// map ships showing the full H3 grid or only the subject cell. Also
// operable live via the button below -- this constant is just the
// default state, not the only way to flip it.
const SHOW_FULL_GRID_BY_DEFAULT = true;

// Road-class weighting, indexed by MapStreet.rank (0=local .. 3=highway) --
// matches the approved prototype exactly (scratchpad/bearings-map.html,
// base=hybrid: stroke-width [0.28, 0.55, 1.0, 1.65], stroke-opacity
// [0.3, 0.62, 0.85, 1] * 0.85 hybrid dimming).
const STREET_WIDTH = [0.28, 0.55, 1.0, 1.65];
const STREET_OPACITY = [0.3, 0.62, 0.85, 1].map((o) => o * 0.85);

function mercator(lng: number, lat: number): [number, number] {
  return [
    (lng + 180) / 360,
    (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2,
  ];
}

function project(geo: MapGeometry) {
  const [x0, y1] = mercator(geo.bbox.west, geo.bbox.south);
  const [x1, y0] = mercator(geo.bbox.east, geo.bbox.north);
  const scale = Math.min(VB_W / (x1 - x0), VB_H / (y1 - y0));
  const ox = (VB_W - (x1 - x0) * scale) / 2;
  const oy = (VB_H - (y1 - y0) * scale) / 2;
  return (lng: number, lat: number): [number, number] => {
    const [mx, my] = mercator(lng, lat);
    return [(mx - x0) * scale + ox, (my - y0) * scale + oy];
  };
}

function pathD(points: [number, number][], close = false): string {
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  return close ? `${d}Z` : d;
}

interface CellGeom extends MapCell {
  boundary: [number, number][]; // [lat, lng]
  home: boolean;
  w: number; // 0..1, density relative to the loudest cell in view -- real data, not a guessed threshold
}

function EdgeTicks() {
  const ticks: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = (VB_W / 12) * i;
    ticks.push(`M${x} 0V7`, `M${x} ${VB_H}V${VB_H - 7}`);
  }
  for (let i = 0; i <= 8; i++) {
    const y = (VB_H / 8) * i;
    ticks.push(`M0 ${y}H7`, `M${VB_W} ${y}H${VB_W - 7}`);
  }
  return (
    <g>
      {ticks.map((d, i) => (
        <path key={i} d={d} stroke={INK} strokeWidth={1} strokeOpacity={0.5} />
      ))}
    </g>
  );
}

function StipplePattern({ id, w }: { id: string; w: number }) {
  // Dot spacing tightens from ~11px at zero density to ~3px at maximum
  // (VISUAL.md §5) -- value is density of mark, never opacity of a wash,
  // so the streets/subway underneath stay legible at any value.
  const sp = 11 - w * 8;
  const r = 0.5 + w * 0.85;
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={sp} height={sp}>
      <circle cx={sp / 2} cy={sp / 2} r={r} fill={INK} />
      <circle cx={0} cy={0} r={r} fill={INK} />
      <circle cx={sp} cy={sp} r={r} fill={INK} />
    </pattern>
  );
}

function HexCell({ cell, p, onHover }: { cell: CellGeom; p: (lng: number, lat: number) => [number, number]; onHover: (c: CellGeom) => void }) {
  const ring = cell.boundary.map(([lat, lng]) => p(lng, lat));
  const d = pathD(ring, true);
  const color = cell.home ? RED : INK;
  const patternId = `stipple-${cell.h3}`;

  return (
    <g className="hexcell" onMouseEnter={() => onHover(cell)}>
      <defs>
        <StipplePattern id={patternId} w={cell.w} />
      </defs>
      <path
        className="hexcell__fill"
        d={d}
        fill={`url(#${patternId})`}
        fillOpacity={cell.home ? 0.95 : 0.78}
        stroke="none"
      />
      <path
        className="hexcell__edge"
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={cell.home ? 2.4 : 0.5 + cell.w * 1.2}
        strokeOpacity={cell.home ? 1 : 0.5}
      />
      {/* invisible hit area so hover works over the empty gaps between dots */}
      <path d={d} fill="transparent" stroke="none" />
    </g>
  );
}

function Readout({ cell }: { cell: CellGeom | null }) {
  if (!cell) {
    return (
      <div className="readout">
        <h3>Cell readout</h3>
        <p className="readout__empty">
          Hover a cell.
          <br />
          <br />
          Its fill will drop away so the streets underneath stay readable while you read the
          number.
        </p>
      </div>
    );
  }
  return (
    <div className="readout">
      <h3>Cell readout</h3>
      <dl>
        <dt>311 noise · trailing 12mo</dt>
        <dd>
          {cell.value}
          <span style={{ fontSize: 11, color: STEEL, marginLeft: 6 }}>calls</span>
        </dd>
        <dt>H3 index · res 9</dt>
        <dd className="small">{cell.h3}</dd>
        <dt>Cell area</dt>
        <dd className="small">0.105 km²</dd>
        {cell.home && (
          <>
            <dt>Status</dt>
            <dd className="small" style={{ color: RED }}>
              SUBJECT CELL
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function MapView({ address }: { address: string }) {
  const [geo, setGeo] = useState<MapGeometry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<CellGeom | null>(null);
  const [fullGrid, setFullGrid] = useState(SHOW_FULL_GRID_BY_DEFAULT);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHovered(null);
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

  const p = useMemo(() => (geo ? project(geo) : null), [geo]);

  const cellGeoms: CellGeom[] = useMemo(() => {
    if (!geo) return [];
    const maxValue = Math.max(1, ...geo.cells.map((c) => c.value));
    return geo.cells
      .filter((c) => fullGrid || c.h3 === geo.subject.cell)
      .map((c) => ({
        ...c,
        home: c.h3 === geo.subject.cell,
        boundary: h3.cellToBoundary(c.h3) as [number, number][],
        w: c.value / maxValue,
      }));
  }, [geo, fullGrid]);

  if (loading) {
    return (
      <div className="mapfield">
        <p className="loading mono">Drawing the map…</p>
      </div>
    );
  }

  if (error || !geo || !p) {
    return (
      <div className="mapfield">
        <p className="field__empty">{error ?? "Map geometry unavailable."}</p>
      </div>
    );
  }

  return (
    <div className="mapfield">
      <h2 className="field__title">The neighbourhood, drawn</h2>

      <div className="mapfield__controls">
        <span>H3 grid</span>
        <button
          type="button"
          className="mapfield__toggle"
          aria-pressed={fullGrid}
          onClick={() => setFullGrid(true)}
        >
          Full grid
        </button>
        <button
          type="button"
          className="mapfield__toggle"
          aria-pressed={!fullGrid}
          onClick={() => setFullGrid(false)}
        >
          Subject cell only
        </button>
      </div>

      <div className="mapfield__stage">
        <div>
          <div className="mapfield__frame">
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              aria-label="H3 cell map with real building footprints, street centrelines, and subway alignments"
            >
              {/* Building mass, no outline -- reads as ground (VISUAL.md §5). */}
              {geo.buildings.map((b, i) => (
                <path
                  key={i}
                  d={pathD(b.coords.map(([lat, lng]) => p(lng, lat)), true)}
                  fill={STEEL}
                  fillOpacity={0.34}
                  stroke="none"
                />
              ))}

              {/* Street hairlines, weighted by road class -- ink, on top of
                  the building mass but under everything else. */}
              {geo.streets.map((s, i) => (
                <path
                  key={i}
                  d={pathD(s.coords.map(([lat, lng]) => p(lng, lat)))}
                  fill="none"
                  stroke={INK}
                  strokeWidth={STREET_WIDTH[s.rank]}
                  strokeOpacity={STREET_OPACITY[s.rank]}
                  strokeLinecap="round"
                />
              ))}

              {geo.subway_lines.map((line, i) => (
                <path
                  key={i}
                  d={pathD(line.coords.map(([lat, lng]) => p(lng, lat)))}
                  fill="none"
                  stroke={RED}
                  strokeWidth={2.7}
                  strokeOpacity={0.92}
                  strokeLinecap="round"
                />
              ))}
              {geo.stations.map((s, i) => {
                const [x, y] = p(s.lng, s.lat);
                return <circle key={i} cx={x} cy={y} r={4} fill={BONE} stroke={RED} strokeWidth={1.8} />;
              })}

              {cellGeoms.map((c) => (
                <HexCell key={c.h3} cell={c} p={p} onHover={setHovered} />
              ))}

              {/* subject lot registration mark */}
              {(() => {
                const [sx, sy] = p(geo.subject.lng, geo.subject.lat);
                const a = 13;
                return (
                  <>
                    <path
                      d={`M${sx - a} ${sy}H${sx + a}M${sx} ${sy - a}V${sy + a}`}
                      stroke={RED}
                      strokeWidth={2}
                    />
                    <circle cx={sx} cy={sy} r={6} fill="none" stroke={RED} strokeWidth={2} />
                  </>
                );
              })()}

              <EdgeTicks />
            </svg>
          </div>
          <div className="mapfield__legend">
            <span>
              <i style={{ background: STEEL, opacity: 0.34 }} />
              Building footprint
            </span>
            <span>
              <i style={{ background: INK, height: 2 }} />
              Street, by road class
            </span>
            <span>
              <i style={{ background: RED }} />
              Subway / PATH — real alignment
            </span>
            <span>
              <i style={{ border: `1.5px solid ${RED}`, background: "none", height: 8, width: 8, borderRadius: "50%" }} />
              Station
            </span>
            <span>
              <i style={{ border: `1px solid ${INK}`, background: "none" }} />
              H3 res-9 cell · 0.105 km²
            </span>
          </div>
        </div>
        <Readout cell={hovered} />
      </div>

      <p className="mapfield__note mono">{geo.basemap_note}</p>
    </div>
  );
}
