"""Point-in-polygon lookup for NYPD precinct boundaries.

DuckDB's spatial extension gives us ST_Contains without pulling in geopandas
and its GDAL dependency chain, which on Windows is a genuine liability."""

from functools import lru_cache

import duckdb
import httpx

from bearings import config, staleness


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
