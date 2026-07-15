// Mirrors the API contract exactly (see the dispatch spec / bearings/src/bearings/api.py
// _to_contract()). Do not rename or reshape these -- the backend is the source of truth.

export interface Source {
  name: string;
  url: string;
}

export interface Station {
  name: string;
  routes: string[];
  walk_minutes: number;
}

export interface ToAnchors {
  midtown: number;
  wtc: number;
  downtown_brooklyn: number;
  newport_path: number;
}

export interface Transit {
  nearest_stations: Station[];
  to_anchors: ToAnchors;
  caveat: string;
  source: Source;
}

export interface AmenityCounts {
  grocery: number;
  cafe: number;
  bar: number;
  restaurant: number;
  pharmacy: number;
  gym: number;
  park: number;
  laundry: number;
}

export interface Amenities {
  counts: AmenityCounts;
  source: Source;
}

// Empty object when no precinct match was found for the point -- every field is
// therefore optional, and the UI must render a real fallback state, not a broken grid.
// `source` follows the same rule: it's only present when there's real data to cite.
export interface Safety {
  precinct?: number;
  week_ending?: string;
  robbery_ytd?: number;
  robbery_pct?: number;
  felony_assault_ytd?: number;
  felony_assault_pct?: number;
  total_ytd?: number;
  total_pct?: number;
  // This precinct's percentile position (0-100) among every real NYC
  // precinct's own YTD major-crime count -- crime is relative-to-NYC, not
  // an absolute number on its own (VISUAL.md §5). See web/src/lib/crime.ts.
  crime_percentile?: number;
  crime_caveat?: string;
  source?: Source;
}

export interface Quiet {
  noise_complaints_12mo: number | null;
  source: Source;
}

export interface Green {
  street_trees_nearby: number | null;
  source: Source;
}

export interface HpdViolations {
  class_a: number;
  class_b: number;
  class_c: number;
}

export type Era = "prewar" | "postwar" | "modern" | null;

export interface Building {
  year_built: number | null;
  era: Era;
  era_note: string | null;
  // null when the address has no BBL (bearings/profile.py's _building()) --
  // there's no lot to look violations up on, not zero violations.
  hpd_open_violations: HpdViolations | null;
  source: Source;
}

export interface Location {
  lat: number;
  lng: number;
  bbl: string | null;
}

export interface Profile {
  address: string;
  cell: string;
  location: Location;
  transit: Transit;
  amenities: Amenities;
  safety: Safety;
  quiet: Quiet;
  green: Green;
  building: Building;
}

export type ClaimStatus = "supported" | "contradicted" | "unfalsifiable" | "no_data";

export interface Claim {
  quote: string;
  predicate: string;
  status: ClaimStatus;
  evidence: string;
  value: number | null;
  source: Source;
}

export interface FactcheckResult {
  address: string;
  claims: Claim[];
}

// Mirrors GET /api/map exactly (bearings/mapgeo.py's map_geometry()). Every
// layer here is real, baked from public records -- see that module's own
// docstring for the building-footprint / street-centreline build-time-bake
// pipeline (sources/buildings.py, sources/streets.py).
export interface MapSubject {
  lat: number;
  lng: number;
  bbl: string | null;
  cell: string;
}

export interface MapBbox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface MapLine {
  coords: [number, number][]; // [lat, lng]
  route: string; // e.g. "B/D/F/M", "PATH" -- see sources/gtfs.py's shape_routes()
}

export interface MapStation {
  name: string;
  lat: number;
  lng: number;
  routes: string[];
}

export interface MapCell {
  h3: string;
  value: number;
}

export interface MapBuilding {
  bbl: string | null;
  coords: [number, number][]; // [lat, lng], exterior ring
}

export interface MapStreet {
  physicalid: string;
  coords: [number, number][]; // [lat, lng]
  rank: 0 | 1 | 2 | 3; // 3 = highway, 0 = local -- see sources/streets.py
}

export interface MapGeometry {
  subject: MapSubject;
  bbox: MapBbox;
  buildings: MapBuilding[];
  streets: MapStreet[];
  subway_lines: MapLine[];
  stations: MapStation[];
  cells: MapCell[];
  basemap_note: string;
  sources: Record<string, Source>;
}

// Mirrors GET /api/citywide exactly (bearings/citywide.py's get()). Unlike
// MapGeometry above, none of this depends on which address is loaded --
// it's fetched once, not once per address (see citywide.py's own
// docstring).
export interface NeighborhoodLabel {
  nta2020: string;
  name: string;
  borough: string;
  lat: number;
  lng: number;
}

export interface PrecinctCrime {
  week_ending: string;
  robbery_ytd: number;
  felony_assault_ytd: number;
  total_ytd: number;
  // 0-100, median-neutral (~50) -- see bearings/citywide.py's
  // percentile_rank() and web/src/lib/crime.ts.
  crime_percentile: number;
}

// GeoJSON Polygon/MultiPolygon -- typed loosely (not `Geometry` from
// @types/geojson, which this repo doesn't depend on) since MapLibre's own
// GeoJSONSource.setData() accepts `GeoJSON.GeoJSON | string` and does its
// own runtime validation; the map component only ever passes this straight
// through into a Feature it builds.
export interface PrecinctGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
}

export interface PrecinctFeature {
  precinct: number;
  lat: number;
  lng: number;
  geometry: PrecinctGeometry;
  // `null` when this one precinct's live CompStat fetch genuinely failed
  // during the citywide bake -- never a fabricated zero. See citywide.py's
  // _crime_for_precinct() docstring.
  crime: PrecinctCrime | null;
}

export interface Citywide {
  neighborhoods: NeighborhoodLabel[];
  precincts: PrecinctFeature[];
  neighborhoods_source: Source;
  precincts_source: Source;
  crime_source: Source;
  crime_caveat: string;
}
