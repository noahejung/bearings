import type {
  CellProfile,
  CellsIndex,
  Citywide,
  FactcheckResult,
  GeocodeResult,
  MapGeometry,
  Profile,
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
