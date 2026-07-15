"""Point-in-polygon lookup for NYPD precinct boundaries, plus the citywide
polygon export used by the map's precinct choropleth (VISUAL.md §5's
"Heat-map (toggle) ... crime is per-precinct").

DuckDB's spatial extension gives us ST_Contains without pulling in geopandas
and its GDAL dependency chain, which on Windows is a genuine liability."""

import json
from functools import lru_cache

import duckdb
import httpx
import pandas as pd

from bearings import config, staleness

SOURCE = {
    "name": "NYPD Police Precincts",
    "url": "https://data.cityofnewyork.us/d/y76i-bdw7",
}


@lru_cache(maxsize=1)
def _con() -> duckdb.DuckDBPyConnection:
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = config.RAW_DIR / "precincts.geojson"

    if not path.exists():
        resp = httpx.get(config.PRECINCT_GEOJSON, timeout=60.0, follow_redirects=True)
        resp.raise_for_status()
        path.write_bytes(resp.content)
    else:
        staleness.warn_if_stale(path, config.PRECINCT_CACHE_MAX_AGE_S, "precinct boundaries")

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        f"""
        CREATE TABLE precincts AS
        SELECT CAST(precinct AS INTEGER) AS precinct, geom
        FROM ST_Read('{path.as_posix()}')
        """
    )
    return con


def precinct_for(lat: float, lng: float) -> int | None:
    row = _con().execute(
        "SELECT precinct FROM precincts WHERE ST_Contains(geom, ST_Point(?, ?)) LIMIT 1",
        [lng, lat],  # note: ST_Point takes (x, y) = (lng, lat)
    ).fetchone()
    return int(row[0]) if row else None


def precincts_for_points(points: list[tuple[str, float, float]]) -> dict[str, int | None]:
    """Batched point-in-polygon: {key: precinct | None} for every (key, lat,
    lng) in `points`, in ONE spatial join instead of one precinct_for()
    call per point -- built for the per-cell precompute bake (bearings.
    cellprofile), which needs this for ~7,000 cell centroids at once.

    Registers `points` as a real DuckDB-visible pandas DataFrame
    (`con.register()`) rather than passing the three columns through
    positional `unnest($1), unnest($2), unnest($3)` parameters -- a live
    probe found the unnest form silently drops/merges a handful of rows
    (6,997 rows back for 7,017 real distinct input keys, no error), while
    `register()` returns exactly one row per input key, every time, and
    runs roughly 20x faster besides (DuckDB's join planner treats a
    registered relation very differently from three parallel array
    parameters). A point outside every precinct polygon (open water, a gap
    at simplified boundary edges, Rikers Island) maps to `None` -- never a
    guessed nearest precinct.
    """
    if not points:
        return {}
    con = _con()
    df = pd.DataFrame(points, columns=["key", "lat", "lng"])
    con.register("_pts", df)
    try:
        rows = con.execute(
            """
            SELECT _pts.key, MIN(pr.precinct) AS precinct
            FROM _pts
            LEFT JOIN precincts pr ON ST_Contains(pr.geom, ST_Point(_pts.lng, _pts.lat))
            GROUP BY _pts.key
            """
        ).fetchall()
    finally:
        con.unregister("_pts")
    return {key: (int(pct) if pct is not None else None) for key, pct in rows}


def all_precinct_numbers() -> list[int]:
    """Every real NYPD precinct number in the boundary dataset (78, as of
    2026-07-13 -- see the module's own docstring for why that's not 77).
    The live source of truth for "which precincts exist", rather than a
    hardcoded 1..123 range -- NYC precinct numbers are not contiguous."""
    rows = _con().execute("SELECT precinct FROM precincts ORDER BY precinct").fetchall()
    return [int(r[0]) for r in rows]


def precinct_features(simplify_tolerance_deg: float = config.PRECINCT_SIMPLIFY_TOLERANCE_DEG) -> list[dict]:
    """Every precinct citywide, as {"precinct": int, "lat": float,
    "lng": float, "geometry": dict} for the map's precinct choropleth and
    label layer -- `geometry` is a real GeoJSON Polygon/MultiPolygon,
    `lat`/`lng` its centroid (a label-placement point).

    Polygons are simplified (Douglas-Peucker, topology-preserving) before
    being serialised -- live-measured 2026-07-15: full-precision citywide
    is 3.83MB across 78 precincts (avg 1,257 points/precinct, max 15,848);
    at the default 0.0003deg (~30m at NYC's latitude) tolerance that drops
    to 243KB / 6,132 total points with no visible loss at any zoom where
    the whole city is on screen. This is a one-time citywide fetch (the map
    loads it once, not once per address), so 243KB is a real, deliberate
    trade against 3.83MB, not a change nobody would notice either way.
    """
    rows = _con().execute(
        f"""
        SELECT precinct,
               ST_Y(ST_Centroid(geom)) AS lat,
               ST_X(ST_Centroid(geom)) AS lng,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, ?)) AS geometry_json
        FROM precincts
        ORDER BY precinct
        """,
        [simplify_tolerance_deg],
    ).fetchall()
    return [
        {
            "precinct": int(precinct),
            "lat": float(lat),
            "lng": float(lng),
            "geometry": json.loads(geometry_json),
        }
        for precinct, lat, lng, geometry_json in rows
    ]
