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
}

export interface Amenities {
  grocery: number;
  cafe: number;
  bar: number;
  restaurant: number;
  pharmacy: number;
  gym: number;
  park: number;
  laundry: number;
}

// Empty object when no precinct match was found for the point -- every field is
// therefore optional, and the UI must render a real fallback state, not a broken grid.
export interface Safety {
  precinct?: number;
  week_ending?: string;
  robbery_ytd?: number;
  robbery_pct?: number;
  felony_assault_ytd?: number;
  felony_assault_pct?: number;
  total_ytd?: number;
  total_pct?: number;
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
  hpd_open_violations: HpdViolations;
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
