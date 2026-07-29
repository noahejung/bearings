"""Reach rings -- 5/10/15-minute walk isochrones from a searched address
(SPEC-lens-report.md §3), plus the real named places and transit stations
that fall inside them.

**Isochrone computation, and why this is a straight-line approximation, not
true street-network routing (the plan-time decision SPEC-lens-report.md
asks for, recorded here with evidence).** This codebase has no routable
pedestrian graph: sources/streets.py bakes NYC's Street Centerline dataset
as flat, disconnected polyline PARTS (physicalid/coords/rank), never
snapped into shared intersection nodes -- there is no node/edge topology
anywhere in this codebase for a person walking, only for the subway/PATH
network (transit.py's build_graph(), a completely different graph).
Building a real pedestrian graph (snapping real-world GIS line endpoints
into a routable network, handling dangling segments, bridges, medians) is
a distinct, nontrivial project, not a slice-1-sized addition.

This module instead reuses the exact straight-line/WALK_SPEED_MPS
methodology this codebase has already shipped TWICE:
  - mapgeo.py's TRANSIT_ACCESS_RADIUS_M: "roughly 6 minutes at
    transit.WALK_SPEED_MPS" -- a proxy metric, not a routed one.
  - CellReportView.tsx's amenities caption: "measured as a straight line,
    not an actual walking route, so it can over- or under-count near
    rivers, parks, or highways."
So a pure circle (radius_m = WALK_SPEED_MPS * minutes * 60) is not a new,
weaker honesty standard for this feature -- it's the same one already
reviewed and shipped, applied a third time. No invented "circuity
correction factor" is used: an uncited detour-factor constant would itself
be an unsupported number, the exact "plausible but unverified" failure
class this project's own rules forbid. Every ring is labelled "roughly" in
the UI, with the same straight-line caveat the amenities card already uses.
"""

import math

import duckdb

from bearings import config
from bearings.geocode import geocode
from bearings.mapgeo import AMENITY_CATEGORIES, _bbox_for
from bearings.sources import gtfs, overture
from bearings.transit import SOURCE as TRANSIT_SOURCE
from bearings.transit import WALK_SPEED_MPS, _haversine_m

REACH_BANDS_MINUTES: tuple[int, ...] = (5, 10, 15)

_POIS_PATH = config.DERIVED_DIR / "pois.parquet"

METHOD_NOTE = (
    "Roughly how far you could walk in 5, 10, and 15 minutes at a normal walking pace "
    "(about 3 miles an hour) -- measured as a straight line from the address, not an "
    "actual walking route, so it can reach further than a real walk would near rivers, "
    "parks, highways, or a long block."
)


def band_radius_m(minutes: int) -> float:
    """The straight-line radius (metres) a person covers in `minutes` at
    WALK_SPEED_MPS -- see the module docstring for why this is a circle,
    not a routed shape."""
    return WALK_SPEED_MPS * minutes * 60.0


def _band_for(distance_m: float) -> int | None:
    """The smallest real band whose radius covers `distance_m`, or `None`
    if it falls outside every band (beyond the largest radius) -- never a
    fabricated closer/farther band."""
    for minutes in REACH_BANDS_MINUTES:
        if distance_m <= band_radius_m(minutes):
            return minutes
    return None


def _ring_polygon(lat: float, lng: float, radius_m: float, n: int = 64) -> list[list[float]]:
    """A real circle of radius `radius_m` around (lat, lng), as a closed
    [[lat, lng], ...] ring -- longitude-corrected for latitude the same way
    mapgeo._bbox_for() already is (a degree of longitude shrinks toward the
    poles; at these NYC latitudes and radii the correction is real, not a
    rounding nicety)."""
    dlat_per_m = 1.0 / 111_320.0
    dlng_per_m = 1.0 / (111_320.0 * math.cos(math.radians(lat)))
    ring: list[list[float]] = []
    for i in range(n + 1):  # +1 to close the ring
        theta = 2 * math.pi * i / n
        d_lat = radius_m * math.sin(theta) * dlat_per_m
        d_lng = radius_m * math.cos(theta) * dlng_per_m
        ring.append([lat + d_lat, lng + d_lng])
    return ring


def _bands(lat: float, lng: float) -> list[dict]:
    return [
        {
            "minutes": minutes,
            "radius_m": band_radius_m(minutes),
            "polygon": _ring_polygon(lat, lng, band_radius_m(minutes)),
        }
        for minutes in REACH_BANDS_MINUTES
    ]


def _places_near(lat: float, lng: float, radius_m: float) -> list[dict]:
    """Every real Overture POI (all 8 AMENITY_CATEGORIES) within `radius_m`
    of (lat, lng), each tagged with the smallest real band it falls inside
    -- read from the already-baked data/derived/pois.parquet (same file
    mapgeo._amenity_cell_counts() reads), never a live fetch. Raises the
    same loud not-baked-yet FileNotFoundError that function's own guard
    does, rather than silently returning an empty list that looks like
    "no places nearby" instead of "not baked yet"."""
    if not _POIS_PATH.exists():
        raise FileNotFoundError(
            f"{_POIS_PATH} has not been baked yet -- call bearings.profile."
            "warm_caches() first (api.py's startup handler does this automatically)."
        )
    bbox = _bbox_for(lat, lng, radius_m)
    con = duckdb.connect()
    try:
        cat_placeholders = ",".join("?" for _ in AMENITY_CATEGORIES)
        rows = con.execute(
            f"""
            SELECT name, category, lat, lng
            FROM read_parquet('{_POIS_PATH.as_posix()}')
            WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
              AND category IN ({cat_placeholders})
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"], *AMENITY_CATEGORIES],
        ).fetchall()
    finally:
        con.close()

    out: list[dict] = []
    for name, category, plat, plng in rows:
        d = _haversine_m((lat, lng), (plat, plng))
        if d > radius_m:
            continue
        band = _band_for(d)
        if band is None:
            continue
        out.append(
            {
                "name": name,
                "category": category,
                "lat": float(plat),
                "lng": float(plng),
                "band_minutes": band,
            }
        )
    return out


def _stations_near(lat: float, lng: float, radius_m: float) -> list[dict]:
    """Every real subway/PATH station within `radius_m` of (lat, lng), each
    tagged with the smallest real band it falls inside -- reuses the same
    per-feed gtfs.stations() call mapgeo._stations_in_bbox() already makes,
    no new fetch."""
    out: list[dict] = []
    for feed in gtfs.FEEDS:
        for row in gtfs.stations(feed).itertuples():
            d = _haversine_m((lat, lng), (row.lat, row.lng))
            if d > radius_m:
                continue
            band = _band_for(d)
            if band is None:
                continue
            out.append(
                {
                    "name": row.name,
                    "lat": float(row.lat),
                    "lng": float(row.lng),
                    "routes": list(row.routes),
                    "band_minutes": band,
                }
            )
    return out


def reach(address: str) -> dict:
    """Everything the reach-rings map feature needs for one searched
    address: three real walk-time bands (see the module docstring for why
    they're straight-line, not routed), every real named place/station
    inside the largest band, and the honest method note + real sources for
    both. Raises geocode.GeocodeError on an address this codebase can't
    resolve (api.py turns that into a 422, matching GET /api/map)."""
    loc = geocode(address)
    max_radius = band_radius_m(max(REACH_BANDS_MINUTES))
    return {
        "center": {"lat": loc.lat, "lng": loc.lng},
        "bands": _bands(loc.lat, loc.lng),
        "places": _places_near(loc.lat, loc.lng, max_radius),
        "stations": _stations_near(loc.lat, loc.lng, max_radius),
        "method_note": METHOD_NOTE,
        "sources": {"places": dict(overture.SOURCE), "stations": dict(TRANSIT_SOURCE)},
    }
