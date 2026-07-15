"""Assemble the per-address profile.

Everything expensive (POI ingest, the transit graph, Dijkstra from each
anchor) is computed once and memoised. The two slowest pieces -- the POI
table (pulled from Overture over S3) and the anchor-time dict (a full
Dijkstra run from every anchor) -- are additionally persisted to
`config.DERIVED_DIR` as build-time artefacts: the first call in the data
directory's lifetime pays the real cost and writes the result to disk;
every call after that, in this run or a future one, loads it back in
milliseconds. `warm_caches()` is the seam the HTTP API (api.py) calls on
startup so the first real request is never the one paying for a cold
boot."""

import json
from functools import lru_cache

import duckdb
import pandas as pd

from bearings import cells, citywide, config, geocode, staleness, transit
from bearings.sources import compstat, gtfs, hpd, noise, overture, pluto, precincts, trees
from bearings.transit import WALK_SPEED_MPS, _haversine_m

NEAREST_STATION_COUNT = 3
STATION_SEARCH_M = 1200.0

# One merged citation for the building block: PLUTO supplies year_built/era,
# HPD supplies hpd_open_violations. The contract calls for a single source
# object here rather than one per field, so this borrows HPD's dataset URL
# (arbitrary choice between the two -- both are cited by name) rather than
# inventing a third URL that points at neither dataset.
_BUILDING_SOURCE = {"name": "NYC PLUTO + HPD", "url": hpd.SOURCE["url"]}

# Keyed by era ("prewar"/"postwar"/"modern"); None has no note -- there is
# nothing to say about an age we don't know. Prewar wording matches the
# API contract's example exactly; postwar/modern follow SPEC.md's framing
# of building age as an affordability *signal*, never a promise.
_ERA_NOTES = {
    "prewar": (
        "Pre-war walk-up stock often carries rent-stabilised units, so a "
        "cheap apartment may exist here. This is a signal, not a promise."
    ),
    "postwar": (
        "Mid-century construction is a mixed bag for rent stabilisation -- "
        "check the building's individual history rather than assuming from "
        "age alone. This is a signal, not a promise."
    ),
    "modern": (
        "Post-2000 construction rarely carries rent-stabilised units -- the "
        "price you see is close to the price you'll pay. This is a signal, "
        "not a promise."
    ),
}


_POIS_PATH = config.DERIVED_DIR / "pois.parquet"
_ANCHOR_TIMES_PATH = config.DERIVED_DIR / "anchor_times.json"


def _write_parquet(df: pd.DataFrame, path) -> None:
    """Write a DataFrame to Parquet via DuckDB -- already a dependency, so
    this needs no new package (pandas' own to_parquet requires pyarrow,
    which nothing here otherwise pulls in)."""
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.register("_df", df)
    con.execute(f"COPY _df TO '{path.as_posix()}' (FORMAT PARQUET)")
    con.close()


def _read_parquet(path) -> pd.DataFrame:
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{path.as_posix()}')").fetch_df()
    con.close()
    return df


@lru_cache(maxsize=1)
def _pois():
    """The Overture POI table -- ~478k rows pulled over S3, which is the
    single slowest thing this module does. Persisted to disk (see the
    module docstring) so only the very first boot ever pays for it."""
    if _POIS_PATH.exists():
        staleness.warn_if_stale(_POIS_PATH, config.POI_CACHE_MAX_AGE_S, "POI table")
        return _read_parquet(_POIS_PATH)
    df = overture.fetch_pois()
    _write_parquet(df, _POIS_PATH)
    return df


@lru_cache(maxsize=1)
def _stations():
    # Every feed, not just the subway -- an address near Newport should
    # see PATH stations in nearest_stations, not just whatever subway
    # happens to be 1200m away. Not persisted to disk: both GTFS zips are
    # already cached locally by sources/gtfs.py, so parsing them from disk
    # is already fast -- there's no cold-vs-warm gap here worth closing.
    return pd.concat([gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True)


@lru_cache(maxsize=1)
def _anchor_times():
    """{anchor: {stop_id: seconds}} -- a full Dijkstra run from every
    anchor over the whole transit graph. Persisted to disk for the same
    reason _pois() is: it's real work, and it never changes without a new
    GTFS feed, so there is no reason to redo it every boot."""
    if _ANCHOR_TIMES_PATH.exists():
        staleness.warn_if_stale(
            _ANCHOR_TIMES_PATH, config.ANCHOR_TIMES_CACHE_MAX_AGE_S, "anchor-times"
        )
        with _ANCHOR_TIMES_PATH.open() as f:
            raw = json.load(f)
        return {
            anchor: {stop: int(sec) for stop, sec in by_stop.items()}
            for anchor, by_stop in raw.items()
        }
    times = transit.times_from_anchors()
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    with _ANCHOR_TIMES_PATH.open("w") as f:
        json.dump(times, f)
    return times


def warm_caches() -> None:
    """Populate every module-level cache profile_for() depends on: the POI
    table, the station tables, and the anchor-time dict (which builds the
    transit graph and runs Dijkstra as a side effect). Called once by
    api.py's startup handler so the first real HTTP request never pays the
    cold-boot cost. Safe to call more than once -- every cache here is
    memoised, so repeat calls are free.
    """
    _pois()
    _stations()
    _anchor_times()


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


def _crime_percentile(total_ytd: int) -> float | None:
    """This precinct's percentile position (0-100, median-neutral) against
    every other real precinct's own YTD major-crime count -- crime is
    relative-to-NYC, never an absolute count on its own (VISUAL.md §5). See
    citywide.percentile_rank()'s docstring for the exact method and
    citywide.py's module docstring for why raw counts, not a per-capita
    rate, are the denominator (no NYPD/NYC Open Data precinct-population
    table exists -- checked live, not assumed).

    citywide.warm_caches() is a no-op once data/derived/citywide.json
    already exists (the common case: api.py's lifespan startup bakes it
    before any request can arrive) -- called here too so the CLI path
    (bearings.cli, which never calls citywide.warm_caches() itself) still
    gets a real percentile rather than a crash, at the cost of paying the
    citywide bake once on a genuinely fresh data/ directory, same tradeoff
    _pois()/_anchor_times() already make for their own first call.
    """
    citywide.warm_caches()
    totals = [
        p["crime"]["total_ytd"] for p in citywide.get()["precincts"] if p["crime"] is not None
    ]
    if not totals:
        return None
    return citywide.percentile_rank(totals, total_ytd)


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
        "crime_percentile": _crime_percentile(c["total_ytd"]),
    }


@lru_cache(maxsize=256)
def _quiet(lat: float, lng: float) -> dict:
    return {
        "noise_complaints_12mo": noise.complaints_near(lat, lng),
        "source": dict(noise.SOURCE),
    }


@lru_cache(maxsize=256)
def _green(lat: float, lng: float) -> dict:
    return {
        "street_trees_nearby": trees.near(lat, lng),
        "source": dict(trees.SOURCE),
    }


@lru_cache(maxsize=256)
def _pluto_building(bbl: str) -> dict:
    return pluto.building(bbl)


@lru_cache(maxsize=256)
def _hpd_violations(bbl: str) -> dict:
    return hpd.open_violations(bbl)


def _building(bbl: str | None) -> dict:
    # No BBL means genuinely no way to look this building up -- every field
    # here must be null, never a guessed or zeroed value.
    if bbl is None:
        year_built, era, violations = None, None, None
    else:
        b = _pluto_building(bbl)
        year_built, era = b["year_built"], b["era"]
        violations = _hpd_violations(bbl)

    return {
        "year_built": year_built,
        "era": era,
        "era_note": _ERA_NOTES.get(era),
        "hpd_open_violations": violations,
        "source": dict(_BUILDING_SOURCE),
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
        "quiet": _quiet(loc.lat, loc.lng),
        "green": _green(loc.lat, loc.lng),
        "building": _building(loc.bbl),
    }
