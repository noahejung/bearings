import type {
  AutocompleteResult,
  CellProfile,
  CellsIndex,
  Citywide,
  CommuteResult,
  FactcheckResult,
  GeocodeResult,
  MapGeometry,
  Profile,
  Reach,
  ReverseGeocodeResult,
  RouteResult,
} from "./types";

// Empty string -> relative "/api/..." paths, which the Vite dev proxy (vite.config.ts)
// forwards to the backend, and which work unmodified once both are served from one
// origin in production. VITE_API_BASE_URL is an escape hatch for deployments where the
// API lives on a different origin -- never hardcode a host here.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch {
    throw new ApiError(
      "Could not reach the bearings API. Is it running? (uv run uvicorn bearings.api:app --port 8000)",
      0,
    );
  }

  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === "object" &&
        "detail" in body &&
        typeof (body as { detail: unknown }).detail === "string"
      ) {
        detail = (body as { detail: string }).detail;
      }
    } catch {
      // Body wasn't JSON -- keep the status text.
    }
    throw new ApiError(detail, res.status);
  }

  return res.json() as Promise<T>;
}

export function getProfile(address: string): Promise<Profile> {
  return request<Profile>(`/api/profile?address=${encodeURIComponent(address)}`);
}

export function postFactcheck(address: string, listingText: string): Promise<FactcheckResult> {
  return request<FactcheckResult>("/api/factcheck", {
    method: "POST",
    body: JSON.stringify({ address, listing_text: listingText }),
  });
}

export function getMapGeometry(address: string): Promise<MapGeometry> {
  return request<MapGeometry>(`/api/map?address=${encodeURIComponent(address)}`);
}

// Address-independent -- fetched once, not once per address (see
// bearings/citywide.py's own docstring for why).
export function getCitywide(): Promise<Citywide> {
  return request<Citywide>("/api/citywide");
}

// The fast path (SPEC-precompute-v2.md Phase 2): a single GeoSearch call,
// not a live profile/map compute -- used to resolve a searched address to
// its containing cell before fetching that cell's report via getCell()
// below. See bearings/api.py's get_geocode() docstring.
export function getGeocode(address: string): Promise<GeocodeResult> {
  return request<GeocodeResult>(`/api/geocode?address=${encodeURIComponent(address)}`);
}

// The consolidated search bar's debounced typeahead (LAYOUT-V3 WAVE 1d item
// 11, SPEC-layout-v3.md §8) -- proxies NYC Planning Labs GeoSearch's own
// `/v2/autocomplete` (bearings/geocode.py's `autocomplete()`), median
// ~400-900ms once warm, not sub-100ms -- AddressSearch.tsx debounces the
// call and never blocks typing on it.
export function getAutocomplete(text: string): Promise<{ results: AutocompleteResult[] }> {
  return request<{ results: AutocompleteResult[] }>(
    `/api/geocode/autocomplete?text=${encodeURIComponent(text)}`,
  );
}

// WAVE 6f item 7 (2026-08-11): point -> a hint address for a bare citywide-
// grid cell click, so App.tsx's loadCell() can show the field a real "≈
// <address>" placeholder instead of the old fixed example text that read
// as a stuck value. See bearings/api.py's get_geocode_reverse() docstring
// for why this never 4xx/5xx's.
export function getReverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  return request<ReverseGeocodeResult>(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);
}

// A precomputed block-level report for one real H3 res-9 cell -- a flat
// baked-JSON read, target well under 1s (bearings/api.py's get_cell()
// docstring). Powers both "click any grid cell" and "search an address"
// (search resolves to a cell via getGeocode() first, then calls this).
export function getCell(h3: string): Promise<CellProfile> {
  return request<CellProfile>(`/api/cell/${encodeURIComponent(h3)}`);
}

// The small, flat, citywide grid index -- every real cell's id, centroid,
// and five summary metric values, fetched once when the map mounts (not
// once per address/click) -- see bearings/cellprofile.py's cells_index()
// docstring for why this is a separate, lighter file from the full
// per-cell shards getCell() reads from.
export function getCellsIndex(): Promise<CellsIndex> {
  return request<CellsIndex>("/api/cells");
}

// LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A): a live single-
// destination commute for the editable getting-around region -- the exact
// same profile._anchor_result() machinery the 4 baked ANCHORS already use
// (bearings/api.py's get_commute() docstring), applied to a user-typed
// destination the citywide bake never covers. `cell` is the h3 id driving
// the currently-loaded CellProfile (its own centroid is the origin);
// `destination` is whatever address string the add-destination field
// resolved (a picked autocomplete suggestion's label, or free-typed text
// submitted directly -- both real, geocodable strings, same as
// AddressSearch's own dual submit path). See that endpoint's own docstring
// for the (cell, destination) session cache a repeated selection hits.
export function getCommute(cell: string, destination: string): Promise<CommuteResult> {
  return request<CommuteResult>(
    `/api/commute?cell=${encodeURIComponent(cell)}&destination=${encodeURIComponent(destination)}`,
  );
}

// WAVE 4 (2026-08-11, SPEC-layout-v3.md Wave 4): the real station-by-station
// route + GTFS shape_id(s) a computed commute actually rode -- either one of
// the 4 baked anchors (anchorKey) or a custom destination already resolved
// to a point (destLat/destLng, e.g. from a getCommute()/getAutocomplete()
// result -- never re-geocodes a raw string, unlike getCommute()). Computed
// live on demand (bearings/api.py's get_route() docstring): only called when
// the route-lines toggle is on AND a bar is hovered/selected, never on every
// render, so this never runs on the hot cell-click path.
export function getRoute(
  cell: string,
  destination: { anchorKey: string } | { destLat: number; destLng: number },
): Promise<RouteResult> {
  const params = new URLSearchParams({ cell });
  if ("anchorKey" in destination) {
    params.set("anchor", destination.anchorKey);
  } else {
    params.set("dest_lat", String(destination.destLat));
    params.set("dest_lng", String(destination.destLng));
  }
  return request<RouteResult>(`/api/route?${params.toString()}`);
}

// The 5/10/15-minute reach rings for a searched address (SPEC-lens-report.md
// §3) -- real places/stations inside them plus the ring geometry itself.
// See bearings/reach.py's own module docstring for why the rings are a
// straight-line approximation, not routed street-network isochrones.
export function getReach(address: string): Promise<Reach> {
  return request<Reach>(`/api/reach?address=${encodeURIComponent(address)}`);
}
