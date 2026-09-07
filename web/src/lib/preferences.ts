// Preference-bar state shapes + the category-chip taxonomy (SPEC-lens-
// report.md §2) -- deliberately NOT part of the backend API contract (see
// types.ts's own "mirrors the API contract exactly" rule), so these live
// here instead of there.
//
// WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
// save"): the category chips stay session-only plain useState (unchanged --
// "every visit starts clean" still governs those), but SAVED PLACES
// (formerly "pins") no longer do. SPEC-data-layer-v2.md (2026-08-11) put
// real user accounts ON HOLD and named a client-side localStorage bridge as
// the interim step (§6 open question 3) -- loadSavedPlaces()/
// saveSavedPlaces() below are that bridge: plain browser storage, no
// account, no server round-trip, gone if the user clears site data or
// switches browsers/devices (the honest limit of "client-side interim,"
// not a bug -- real cross-device durability is Wave A of that spec, not
// this one).

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

export interface SavedPlace {
  label: string;
  lat: number;
  lng: number;
}

// localStorage's own key -- namespaced ("bearings.") the same way a real
// per-account table would be scoped to this app alone, not a bare
// "savedPlaces" that could collide with some other site's use of the same
// origin's storage in a shared-browser-profile edge case.
const STORAGE_KEY = "bearings.savedPlaces";

/** Every saved place currently in localStorage, oldest-first -- `[]` for a
 * first-ever visit, a corrupted value (hand-edited devtools, a future
 * schema change), or any environment where `localStorage` itself throws
 * (private-browsing quota limits in some browsers) -- never a thrown
 * exception App.tsx would have to guard on its own render path. */
export function loadSavedPlaces(): SavedPlace[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedPlace =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as SavedPlace).label === "string" &&
        typeof (p as SavedPlace).lat === "number" &&
        typeof (p as SavedPlace).lng === "number",
    );
  } catch {
    return [];
  }
}

/** Persists the full saved-places list -- called with the WHOLE array after
 * every add/remove (App.tsx's own effect), not incrementally, since
 * localStorage has no partial-update API of its own. Silently no-ops on
 * failure (quota exceeded, storage disabled) -- losing the persistence
 * bridge for one write is not worth crashing the add/remove action that
 * triggered it; the in-memory state the UI actually reads from already
 * updated regardless. */
export function saveSavedPlaces(places: SavedPlace[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  } catch {
    // Quota exceeded or storage disabled -- the in-memory list (what the
    // UI actually renders from) is already correct either way.
  }
}
