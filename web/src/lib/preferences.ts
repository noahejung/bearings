// Session-only preference-bar state shapes + the category-chip taxonomy
// (SPEC-lens-report.md §2) -- deliberately NOT part of the backend API
// contract (see types.ts's own "mirrors the API contract exactly" rule),
// so these live here instead of there. No persistence anywhere: every
// consumer (App.tsx, PreferenceBar.tsx, MapView.tsx) holds this state in
// plain `useState`, never localStorage/sessionStorage/a URL param --
// "every visit starts clean" (SPEC-lens-report.md §2).

export interface Chip {
  key: string; // "transit", or one of overture.py's real category buckets
  label: string; // lowercase in source -- see PLAN-lens-report.md's UI-label convention
}

// Exactly Noah's own 6 named examples (SPEC-lens-report.md §2: "cafes, bars
// & venues, parks, groceries, gyms, transit"), not the full 8-bucket real
// Overture taxonomy (which also has restaurant/pharmacy/laundry) -- see
// PLAN-lens-report.md §2 for why this is a deliberate curation, not an
// oversight, and a trivially reversible one (this array is the only place
// it's encoded).
export const REACH_CHIPS: Chip[] = [
  { key: "grocery", label: "groceries" },
  { key: "cafe", label: "cafes" },
  { key: "bar", label: "bars & venues" },
  { key: "park", label: "parks" },
  { key: "gym", label: "gyms" },
  { key: "transit", label: "transit" },
];

export interface PinnedPlace {
  label: string;
  lat: number;
  lng: number;
}
