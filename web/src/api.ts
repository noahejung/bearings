import type { FactcheckResult, MapGeometry, Profile } from "./types";

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
