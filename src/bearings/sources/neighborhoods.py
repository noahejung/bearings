"""NYC Neighborhood Tabulation Areas (NTAs) -- label placement for the
citywide map (VISUAL.md §5's "Neighborhood / precinct labels" layer).

Dataset confirmed live 2026-07-15 via the Socrata catalog
(api.us.socrata.com/api/catalog/v1?q=neighborhood+tabulation):
"9nt8-h7nd", "2020 Neighborhood Tabulation Areas (NTAs)", 262 features,
columns nta2020/ntaname/boroname/the_geom (MultiPolygon). Not the
"2020 Neighborhood Tabulation Areas (NTAs) - Mapped" lens (4hft-v355) --
same pattern as buildings.py/streets.py's own dataset-vs-map-lens
disambiguation: a "- Mapped" lens exists for browsing in Socrata's UI and
carries no queryable columns.

Every one of the 262 rows is a real, named area -- 197 are ntatype='0'
(residential neighbourhoods, e.g. "Greenpoint"), the rest are real named
parks, cemeteries, and institutional areas (ntatype 5/6/7/8/9 -- e.g.
"Prospect Park", "Green-Wood Cemetery", "Yankee Stadium-Macombs Dam Park").
All are kept: a park or cemetery name is exactly as real and exactly as
useful for city-wide orientation as a residential neighbourhood's, and
filtering them out would be an invented distinction this dataset's own
schema doesn't make.

Only a label point (name + centroid) is needed here -- unlike
precincts.py's precinct_features(), no polygon boundary is exposed, because
nothing shades a neighbourhood by area (VISUAL.md's heat-map toggle only
ever shades at a metric's *native* resolution -- H3 cells for noise,
precinct polygons for crime -- and NTAs are not the native resolution of
any metric this codebase computes).
"""

from pathlib import Path

import duckdb
import httpx

from bearings import config, staleness

SOURCE = {
    "name": "NYC Neighborhood Tabulation Areas (NTAs)",
    "url": "https://data.cityofnewyork.us/d/9nt8-h7nd",
}

_RAW_PATH = config.RAW_DIR / "nta.geojson"


def _download() -> Path:
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    if _RAW_PATH.exists():
        staleness.warn_if_stale(_RAW_PATH, config.NTA_CACHE_MAX_AGE_S, "NTA boundaries")
        return _RAW_PATH

    # 262 features citywide (confirmed live 2026-07-15) -- comfortably
    # under Socrata's default page size, so a single request with an
    # explicit $limit above the true count is enough; no pagination loop
    # needed (contrast buildings.py's ~22-page citywide fetch).
    resp = httpx.get(
        config.NTA_GEOJSON, params={"$limit": 1000}, timeout=60.0, follow_redirects=True
    )
    resp.raise_for_status()
    _RAW_PATH.write_bytes(resp.content)
    return _RAW_PATH


def labels() -> list[dict]:
    """Every NTA citywide, as {"nta2020": str, "name": str, "borough": str,
    "lat": float, "lng": float} -- `lat`/`lng` is the polygon's centroid,
    a label-placement point, not a claim about a precise "centre" of the
    neighbourhood (some NTAs are concave; a centroid can land near an edge
    for those). Fetches + caches on first call; cheap enough (one HTTP
    request, ~4.6MB) that no separate warm_cache()/bake-to-Parquet step is
    needed the way buildings.py/streets.py require for citywide datasets
    two to three orders of magnitude larger.
    """
    path = _download()
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        rows = con.execute(
            f"""
            SELECT nta2020, ntaname, boroname,
                   ST_Y(ST_Centroid(geom)) AS lat, ST_X(ST_Centroid(geom)) AS lng
            FROM ST_Read('{path.as_posix()}')
            """
        ).fetchall()
    finally:
        con.close()
    return [
        {"nta2020": code, "name": name, "borough": borough, "lat": float(lat), "lng": float(lng)}
        for code, name, borough, lat, lng in rows
    ]
