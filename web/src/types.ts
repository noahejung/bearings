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

// The two real, live reasons an anchor can be unreachable (bearings/
// profile.py's NO_STATION_IN_RANGE / NO_RAIL_CONNECTION) -- added
// 2026-07-18 to replace a single collapsed "-1"/"no route found" with an
// honest, distinguishable explanation. See web/src/lib/transit.ts for the
// plain-language copy each one maps to, and profile.py's own
// `_anchor_result()` docstring for exactly how each is decided.
export type UnreachableReason = "no_station_in_range" | "no_rail_connection";

// `null` means a real route was found -- always the case exactly when the
// matching `ToAnchors` value is a real, non-negative minute count; the
// two never disagree (see profile.py's `_anchor_result()` docstring).
export interface UnreachableReasons {
  midtown: UnreachableReason | null;
  wtc: UnreachableReason | null;
  downtown_brooklyn: UnreachableReason | null;
  newport_path: UnreachableReason | null;
}

export interface Transit {
  nearest_stations: Station[];
  to_anchors: ToAnchors;
  unreachable_reason: UnreachableReasons;
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

// Five real per-cell metrics (VISUAL.md §5, REVISED 2026-07-15 -- the
// heat-map toggle became a metric dropdown; see bearings/mapgeo.py's own
// module docstring for what each one measures and where its number comes
// from). `building_age_years` is the only metric that can be `null`: the
// real median PLUTO yearbuilt of every lot in a cell, or null when no
// PLUTO lot with a recorded year falls in that cell -- never a fabricated
// year standing in for "no record".
export interface MapCell {
  h3: string;
  noise: number;
  amenities: number;
  trees: number;
  building_age_years: number | null;
  transit_access: number;
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

// Mirrors GET /api/geocode exactly (bearings/api.py's get_geocode()) -- a
// single fast NYC Planning Labs GeoSearch call, not a live profile/map
// compute. Used to resolve a searched address to its containing cell
// before fetching that cell's instant report (SPEC-precompute-v2.md Phase
// 2: "Search an address -> geocode -> cell -> GET /api/cell/{h3}").
export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  bbl: string | null;
  cell: string;
}

// Mirrors GET /api/cells exactly (bearings/cellprofile.py's cells_index())
// -- every real H3 res-9 cell citywide, flattened to just what the map
// grid needs: an id, a centroid (so a click/hover can report a real
// location even before the full profile loads), and the same five
// metric-dropdown summary numbers MapCell already carries (see that
// interface's own comment) -- but for EVERY real cell citywide, not just
// the 37 in one address's local disk. Deliberately NOT the full per-cell
// report (that's what GET /api/cell/{h3} is for, fetched only for
// whichever one cell was actually clicked or searched).
export interface CellsIndexEntry {
  h3: string;
  lat: number;
  lng: number;
  noise: number;
  amenities: number;
  trees: number;
  building_age_years: number | null;
  transit_access: number;
}

export interface CellsIndex {
  cells: CellsIndexEntry[];
}

// Mirrors GET /api/cell/{h3} exactly (bearings/cellprofile.py's
// profile_for()) -- a full, real, BLOCK-level report for one H3 res-9
// cell, precomputed at build time (SPEC-precompute-v2.md Phase 1) so this
// loads in well under 1s, unlike the live per-BUILDING /api/profile.
// Deliberately a different, honest shape from `Profile` above rather than
// forced into it: a block aggregate genuinely does not have a named list
// of nearest stations (only a count) or a per-building HPD violation
// breakdown by class A/B/C (only the aggregated, cell-wide open Class C
// count) -- inventing those fields to fit the building-level `Profile`
// shape would fabricate a precision this data doesn't have. See
// CellReportView.tsx for how each block below is actually rendered.
export interface CellNoise {
  complaints_12mo: number;
  source: Source;
}

export interface CellAmenities {
  counts: AmenityCounts;
  source: Source;
}

export interface CellTrees {
  street_trees: number;
  source: Source;
}

export interface CellBuildingAge {
  median_year_built: number | null;
  era: Era;
  source: Source;
}

export interface CellTransit {
  stations_within_500m: number;
  to_anchors: ToAnchors;
  unreachable_reason: UnreachableReasons;
  caveat: string;
  source: Source;
}

// `crime` mirrors PrecinctCrime above (already defined for /api/citywide) --
// `null` when this cell's centroid resolved to no NYPD precinct (open
// water, a gap at a simplified boundary edge), never a fabricated zero.
export interface CellSafety {
  precinct: number | null;
  crime: PrecinctCrime | null;
  crime_caveat: string;
  source: Source;
}

export interface CellHousingHazards {
  class_c_violations: number;
  note: string;
  source: Source;
}

export interface CellProfile {
  h3: string;
  shard: string;
  centroid: { lat: number; lng: number };
  noise: CellNoise;
  amenities: CellAmenities;
  trees: CellTrees;
  building_age: CellBuildingAge;
  transit: CellTransit;
  safety: CellSafety;
  housing_hazards: CellHousingHazards;
}
