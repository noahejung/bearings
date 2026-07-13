"""Assemble the per-address profile.

Everything expensive (POI ingest, the transit graph, Dijkstra from each
anchor) is computed once and memoised. In Phase 2 these become build-time
artefacts written to disk; for now, module-level caches keep the CLI usable."""

from functools import lru_cache

import pandas as pd

from bearings import cells, geocode, transit
from bearings.sources import compstat, gtfs, overture, precincts
from bearings.transit import WALK_SPEED_MPS, _haversine_m

NEAREST_STATION_COUNT = 3
STATION_SEARCH_M = 1200.0


@lru_cache(maxsize=1)
def _pois():
    return overture.fetch_pois()


@lru_cache(maxsize=1)
def _stations():
    # Every feed, not just the subway -- an address near Newport should
    # see PATH stations in nearest_stations, not just whatever subway
    # happens to be 1200m away.
    return pd.concat([gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True)


@lru_cache(maxsize=1)
def _anchor_times():
    return transit.times_from_anchors()


def _walk_minutes(metres: float) -> int:
    return int(round(metres / WALK_SPEED_MPS / 60))


def _nearby_stations(lat: float, lng: float) -> list[dict]:
    st = _stations()
    out = []
    for row in st.itertuples():
        d = _haversine_m((row.lat, row.lng), (lat, lng))
        if d <= STATION_SEARCH_M:
            out.append(
                {
                    "stop_id": row.stop_id,
                    "name": row.name,
                    "routes": list(row.routes),
                    "walk_minutes": _walk_minutes(d),
                    "_m": d,
                }
            )
    out.sort(key=lambda s: s["_m"])
    for s in out:
        s.pop("_m")
    return out[:NEAREST_STATION_COUNT]


def _to_anchors(nearby: list[dict]) -> dict[str, int]:
    """Total door-to-anchor minutes: walk to a station, then ride.

    We take the best station for each anchor independently -- the fastest
    way to Midtown may not start at the same station as the fastest way to
    WTC.
    """
    times = _anchor_times()
    out: dict[str, int] = {}

    for anchor, by_stop in times.items():
        best: int | None = None
        for s in nearby:
            ride_s = by_stop.get(s["stop_id"])
            if ride_s is None:
                continue
            total = s["walk_minutes"] + int(round(ride_s / 60))
            if best is None or total < best:
                best = total
        out[anchor] = best if best is not None else -1

    return out


def _amenities(cell: str) -> dict[str, int]:
    ring = set(cells.neighbors(cell, k=1))
    near = _pois()[_pois()["cell"].isin(ring)]
    counts = near["category"].value_counts().to_dict()
    counts.pop("other", None)
    return {k: int(v) for k, v in counts.items()}


@lru_cache(maxsize=128)
def _crime(pct: int) -> dict:
    return compstat.fetch_precinct(pct)


def _safety(lat: float, lng: float) -> dict:
    pct = precincts.precinct_for(lat, lng)
    if pct is None:
        return {}

    c = _crime(pct)
    return {
        "precinct": pct,
        "week_ending": c["week_ending"],
        "robbery_ytd": c["robbery_ytd"],
        "robbery_pct": c["robbery_pct"],
        "felony_assault_ytd": c["felony_assault_ytd"],
        "felony_assault_pct": c["felony_assault_pct"],
        "total_ytd": c["total_ytd"],
        "total_pct": c["total_pct"],
    }


def profile_for(address: str) -> dict:
    loc = geocode.geocode(address)
    cell = cells.cell_for(loc.lat, loc.lng)
    nearby = _nearby_stations(loc.lat, loc.lng)

    return {
        "address": loc.label,
        "cell": cell,
        "shard": cells.shard_for(cell),
        "location": {"lat": loc.lat, "lng": loc.lng, "bbl": loc.bbl},
        "transit": {
            "nearest_stations": nearby,
            "to_anchors": _to_anchors(nearby),
        },
        "amenities": _amenities(cell),
        "safety": _safety(loc.lat, loc.lng),
    }
