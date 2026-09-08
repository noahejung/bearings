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
  // WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the join key the
  // route-line preview needs -- GET /api/route returns the real shape_id(s)
  // a computed commute rode; this array (already loaded once per address)
  // is filtered by shape_id client-side to highlight them, no second
  // geometry fetch. See mapgeo._subway_lines()'s own comment.
  shape_id: string;
}

export interface MapStation {
  name: string;
  lat: number;
  lng: number;
  routes: string[];
}

// LAYOUT-V3 WAVE 1e (SPEC-layout-v3.md §8, Noah: "what's stopping us from
// searching up every livable building and mapping that out"). Every real
// footprint now carries its own real PLUTO/HPD attributes -- see
// bearings/sources/buildings.py's footprints_in_bbox() docstring for the
// exact None-vs-0 rules: `year_built`/`era`/`residential`/`hazard_class_c`
// are all `null` for a footprint with no bbl or no matching PLUTO/HPD lot
// (a real "no record"), EXCEPT `hazard_class_c`, which is a real `0` (not
// `null`) whenever the lot itself has a match but no open Class C
// violation ("we looked and found zero").
export interface MapBuilding {
  bbl: string | null;
  coords: [number, number][]; // [lat, lng], exterior ring
  year_built: number | null;
  era: Era;
  residential: boolean | null;
  hazard_class_c: number | null;
}

export interface MapStreet {
  physicalid: string;
  coords: [number, number][]; // [lat, lng]
  rank: 0 | 1 | 2 | 3; // 3 = highway, 0 = local -- see sources/streets.py
}

// ---------------------------------------------------------------------------
// GET /api/building/{bbl} -- SPEC-building-card-v2.md Part A. Five
// per-building sources that were built and tested since July and could not
// reach a reader until now (bearings/buildingrecord.py's module docstring).
//
// The three-state rule below is the contract, and it is not decoration: a
// field is a real value, or `null` meaning "we looked and this source has no
// record for this building", or `Unavailable` meaning "we could not look".
// Collapsing the last two is this project's own recurring bug -- a building
// whose rodent lookup timed out has not passed an inspection.
// ---------------------------------------------------------------------------
export interface Unavailable {
  unavailable: true;
  reason: string;
}

export type Field<T> = T | null | Unavailable;

export function isUnavailable<T>(field: Field<T>): field is Unavailable {
  return (
    typeof field === "object" &&
    field !== null &&
    "unavailable" in field &&
    (field as Unavailable).unavailable === true
  );
}

export interface BedbugRecord {
  filings: number;
  period_end: string | null;
  units_total: number | null;
  units_infested: number | null;
  units_reinfested: number | null;
  units_eradicated: number | null;
}

export interface RodentRecord {
  inspections: number;
  failed: number;
  last_result: string;
  last_date: string;
  months: number;
}

// Never `null`: the bake counts every heat complaint in the city for the
// whole heating season, so a building absent from it has a measured zero,
// not a missing value. Typed as a plain object rather than Field<> for
// exactly that reason -- see buildingrecord.py's own docstring.
export interface HeatRecord {
  complaints: number;
  seasons: number;
  season_start: string | null;
  season_end: string | null;
  caveat: string;
}

export interface FloodRecord {
  zone: string;
  description: string;
  in_special_flood_hazard_area: boolean;
  base_flood_elevation_ft: number | null;
}

export interface PavementRecord {
  segments_rated: number;
  average_rating: number;
  good: number;
  fair: number;
  poor: number;
  most_recent_inspection: string;
}

// `as_of` is the bake date for a baked source and today's date for a live
// one; `baked` says which, so the card's sources line can be honest about
// how old each number is instead of implying they share one vintage.
export interface BuildingSource extends Source {
  as_of: string | null;
  baked: boolean;
}

export interface BuildingRecord {
  bbl: string;
  point: { lat: number; lng: number } | null;
  bedbugs: Field<BedbugRecord>;
  rodents: Field<RodentRecord>;
  heat: HeatRecord;
  flood: Field<FloodRecord>;
  pavement: Field<PavementRecord>;
  sources: Record<string, BuildingSource>;
}

export interface MapGeometry {
  subject: MapSubject;
  bbox: MapBbox;
  buildings: MapBuilding[];
  streets: MapStreet[];
  subway_lines: MapLine[];
  stations: MapStation[];
  // No per-cell metric array. GET /api/map used to carry one (five metrics
  // x the 37 cells of a k=3 disk, three of them live Socrata calls per
  // request); nothing in this app ever read it, and CellsIndexEntry below
  // already carries the identical five for every cell citywide from a
  // baked file. Removed backend-side 2026-09-07.
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

// Mirrors GET /api/geocode/autocomplete exactly (bearings/api.py's
// get_geocode_autocomplete()) -- LAYOUT-V3 WAVE 1d item 11. No `bbl`/`cell`
// (unlike GeocodeResult): a typeahead candidate is a label + point only, a
// real cell lookup happens after the user picks one, via the same
// getGeocode()/getCell() path an address search always used.
export interface AutocompleteResult {
  label: string;
  lat: number;
  lng: number;
}

// Mirrors GET /api/geocode/reverse exactly (bearings/api.py's
// get_geocode_reverse()) -- WAVE 6f item 7. `label` is `null` only in the
// theoretical case both geocode.reverse_geocode() AND citywide.
// nearest_neighborhood() come back empty (see that endpoint's own
// docstring for why the fallback alone should never actually hit this).
// `approximate` is always `true` -- there is no code path where this
// endpoint hands back an authoritative geocode.
export interface ReverseGeocodeResult {
  label: string | null;
  lat: number;
  lng: number;
  approximate: true;
}

// Mirrors GET /api/cells exactly (bearings/cellprofile.py's cells_index())
// -- every real H3 res-9 cell citywide, flattened to just what the map
// grid needs: an id, a centroid (so a click/hover can report a real
// location even before the full profile loads), and five metric summary
// numbers -- for EVERY real cell citywide. `building_age_years` is the
// only one that can be `null`: the real median PLUTO yearbuilt of every
// lot in a cell, or null when no PLUTO lot with a recorded year falls in
// it -- never a fabricated year standing in for "no record". (This used
// to point at MapGeometry's own MapCell for that explanation; MapCell was
// deleted on 2026-09-07 when GET /api/map stopped shipping the field, so
// the explanation lives here now.) Deliberately NOT the full per-cell
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
// LAYOUT-V3 WAVE 1d item 15 (2026-08-03): `percentile`/`caveat` mirror
// `bearings/cellprofile.py`'s `_bake_all()` -- `noise.percentile` (0-100,
// `citywide.percentile_rank()` against every real cell's raw
// `complaints_12mo`, no smoothing) and `noise.caveat`
// (`cellprofile.NOISE_PERCENTILE_CAVEAT`) both shipped in the 2026-08-02
// block-crime/noise-percentile bake (commit `0c39c5d`) but were never
// rendered until now -- confirmed live against a real baked shard before
// wiring (`{"complaints_12mo": 0, "percentile": 7.10, "caveat": "Ranks
// this block's 311 noise complaints against every block citywide..."}`).
// Both fields are always real numbers/strings for every real cell, never
// optional -- `_bake_all()` computes them unconditionally alongside the
// count.
export interface CellNoise {
  complaints_12mo: number;
  percentile: number;
  caveat: string;
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

// Mirrors GET /api/reach exactly (bearings/reach.py's reach()) -- the
// 5/10/15-minute walk-ring feature (SPEC-lens-report.md §3). Every band's
// `polygon` is a real circle (STRAIGHT-LINE, not street-network-routed --
// see reach.py's own module docstring for the plan-time decision and why),
// so the UI must always caption these "roughly", never claim routing
// precision. `band_minutes` on a place/station is the smallest real band
// it falls inside; a place/station outside every band is simply absent
// from these two lists (never a fabricated null entry).
export interface ReachCenter {
  lat: number;
  lng: number;
}

export interface ReachBand {
  minutes: 5 | 10 | 15;
  radius_m: number;
  polygon: [number, number][]; // [lat, lng], closed ring
}

export interface ReachPlace {
  name: string;
  category: string; // one of overture.py's 8 real buckets -- see AMENITY_CATEGORIES
  lat: number;
  lng: number;
  band_minutes: 5 | 10 | 15;
}

export interface ReachStation {
  name: string;
  lat: number;
  lng: number;
  routes: string[];
  band_minutes: 5 | 10 | 15;
}

export interface Reach {
  center: ReachCenter;
  bands: ReachBand[];
  places: ReachPlace[];
  stations: ReachStation[];
  method_note: string;
  sources: { places: Source; stations: Source };
}

// Mirrors GET /api/commute exactly (bearings/api.py's get_commute()) --
// LAYOUT-V3 WAVE 3's editable getting-around row (SPEC-layout-v3.md §5.2
// Option A): a live single-destination commute computed via the exact same
// profile._anchor_result() machinery the 4 baked ANCHORS already use, for a
// destination the citywide bake never covers. `minutes` is -1 exactly when
// `reason` is non-null -- the identical invariant ToAnchors/
// UnreachableReasons already carry for the 4 defaults (see profile.py's
// _anchor_result() docstring).
export interface CommuteDestination {
  label: string;
  lat: number;
  lng: number;
}

export interface CommuteResult {
  destination: CommuteDestination;
  minutes: number;
  reason: UnreachableReason | null;
}

// Mirrors GET /api/route exactly (bearings/api.py's get_route(), backed by
// profile.route_for()) -- WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4):
// route-line preview + nav directions. Every field here comes from a real
// Dijkstra path + real GTFS trips -- never fabricated or interpolated, per
// the spec's own binding rule. `minutes` always matches the corresponding
// ToAnchors/CommuteResult value for the same query -- both read the same
// backend scan (profile._best_candidate()).
export type RouteStep =
  | { type: "walk_to_station"; to: string; minutes: number }
  | { type: "ride"; route: string | null; headsign: string | null; from: string; to: string; shape_ids: string[]; minutes: number }
  | { type: "transfer"; at: string; minutes: number }
  | { type: "walk_to_destination"; minutes: number; estimated: true };

export interface RouteResult {
  reachable: boolean;
  reason: UnreachableReason | null;
  minutes: number;
  steps: RouteStep[] | null;
  shape_ids: string[];
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
