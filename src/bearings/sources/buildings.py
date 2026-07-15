"""NYC building footprints -- the steel "mass" layer under the map's H3
cells and subway lines (VISUAL.md §5's hybrid base: "Buildings ... Steel
#8A8D8F mass at ~34% opacity, no outline -> reads as ground").

mapgeo.py's own module docstring records why a per-request bbox query
against Overture's `buildings` theme (~276GB across 512 files) is not
viable at this codebase's data scale. *This* dataset is different in kind,
not just size: it is NYC-scoped from the source, not a slice of a global
file, so it is small enough to bake in full at build time and slice fast at
request time -- the same build-time-precompute pattern Dockerfile already
uses for the POI table and GTFS feeds (see Dockerfile's own comment on
`profile.warm_caches()`).

Confirmed live 2026-07-14 against data.cityofnewyork.us/resource/5zhs-2jue
(the "BUILDING" dataset -- the queryable table behind the "Building
Footprints (Map)" lens, which itself carries no columns):
  - `$select=count(*)` -> 1,082,881 rows citywide; 1,079,572 with
    `last_status_type='Constructed'` (excludes a small number of
    Demolition/Marked-for-Demolition/Initialization rows).
  - A 5,000-row sample: `the_geom` is always a GeoJSON MultiPolygon with
    exactly one part; 99.86% of those have exactly one ring (no holes),
    the rest have two (a courtyard). Point count per ring: min 5, max 198,
    mean 8.8 -- these are small, simple polygons.
  - One `$limit=50000` page (minimal fields) took ~9.4s and ~22.3MB --
    citywide is ~22 pages, ~207s (~3.5 min) of network time. Real, but
    bounded and one-time: paid once at `docker build` (or once per local
    data/ directory), never in the request path.

At request time, mapgeo.py does a fast bbox slice against the baked
Parquet file: DuckDB's Parquet reader prunes row groups using the
min/max-lat/lng scalar columns computed here at bake time -- the same
producer-side-stats trick overture.py's own `bbox.xmin`/`bbox.xmax`
columns already rely on for the (much larger) Overture Places query.
"""

from pathlib import Path

import duckdb
import pandas as pd

from bearings import config, staleness
from bearings.sources import socrata

SOURCE = {
    "name": "NYC Building Footprints",
    "url": "https://data.cityofnewyork.us/d/5zhs-2jue",
}

_PATH = config.DERIVED_DIR / "buildings.parquet"

# Excludes a handful of non-existent-as-built rows (Demolition, Marked for
# Demolition, Initialization, etc. -- see module docstring) -- confirmed
# live via `$select=last_status_type,count(*)&$group=last_status_type`.
_STATUS_FILTER = "last_status_type='Constructed'"


def _ring_coords(the_geom: dict | None) -> list[list[float]] | None:
    """The exterior ring of a building's MultiPolygon `the_geom`, as
    [[lat, lng], ...]. GeoJSON stores [lng, lat]; flipped here once so
    every consumer downstream (mapgeo.py, MapView.tsx) can assume [lat,
    lng] like every other geometry already in this codebase (subway lines,
    stations, H3 cell boundaries).

    Only the exterior ring (index 0) is kept -- see the module docstring:
    99.86% of footprints have no other ring anyway, and dropping a rare
    courtyard hole is an honest simplification for a "mass" fill layer,
    not a claim about the precise footprint.
    """
    if not isinstance(the_geom, dict):
        return None
    try:
        ring = the_geom["coordinates"][0][0]
    except (KeyError, IndexError, TypeError):
        return None
    if len(ring) < 3:
        return None
    return [[float(lat), float(lng)] for lng, lat in ring]


def _bbox_of(coords: list[list[float]]) -> tuple[float, float, float, float]:
    lats = [p[0] for p in coords]
    lngs = [p[1] for p in coords]
    return min(lats), max(lats), min(lngs), max(lngs)


def fetch_footprints() -> pd.DataFrame:
    """Every real building footprint citywide, as a flat DataFrame ready to
    bake to Parquet: bbl, coords (the exterior ring), and a precomputed
    min/max lat/lng bbox for fast row-group pruning later."""
    raw = socrata.fetch("buildings", select="the_geom,base_bbl", where=_STATUS_FILTER)

    bbls: list[str | None] = []
    coords_col: list[list[list[float]]] = []
    min_lats: list[float] = []
    max_lats: list[float] = []
    min_lngs: list[float] = []
    max_lngs: list[float] = []

    for row in raw.itertuples():
        coords = _ring_coords(row.the_geom)
        if coords is None:
            continue
        min_lat, max_lat, min_lng, max_lng = _bbox_of(coords)
        bbl = row.base_bbl if isinstance(row.base_bbl, str) else None
        bbls.append(bbl)
        coords_col.append(coords)
        min_lats.append(min_lat)
        max_lats.append(max_lat)
        min_lngs.append(min_lng)
        max_lngs.append(max_lng)

    return pd.DataFrame(
        {
            "bbl": bbls,
            "coords": coords_col,
            "min_lat": min_lats,
            "max_lat": max_lats,
            "min_lng": min_lngs,
            "max_lng": max_lngs,
        }
    )


def _write_parquet(df: pd.DataFrame, path: Path) -> None:
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.register("_df", df)
    con.execute(f"COPY _df TO '{path.as_posix()}' (FORMAT PARQUET)")
    con.close()


def warm_cache() -> None:
    """Bake data/derived/buildings.parquet if it doesn't already exist.
    Called once by Dockerfile's build-time step (and by api.py's startup
    handler, mirroring profile.py's own POI-table pattern, so local dev
    gets the same warm-boot-after-first-run behaviour). Real cost the
    first time: ~207s of Socrata pagination (see module docstring). Safe
    to call more than once -- a no-op once the file exists."""
    if _PATH.exists():
        staleness.warn_if_stale(_PATH, config.BUILDINGS_CACHE_MAX_AGE_S, "building footprints")
        return
    _write_parquet(fetch_footprints(), _PATH)


def footprints_in_bbox(bbox: dict) -> list[dict]:
    """Every baked building footprint whose bounding box overlaps `bbox`,
    as {"bbl": str|None, "coords": [[lat,lng],...]}.

    Requires warm_cache() to have baked the Parquet file first -- raises
    FileNotFoundError otherwise (a loud, named guard) rather than silently
    returning an empty layer that looks like "no buildings here" instead
    of "not baked yet".
    """
    if not _PATH.exists():
        raise FileNotFoundError(
            f"{_PATH} has not been baked yet -- call bearings.sources.buildings."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            SELECT bbl, coords FROM read_parquet('{_PATH.as_posix()}')
            WHERE max_lat >= ? AND min_lat <= ? AND max_lng >= ? AND min_lng <= ?
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {"bbl": bbl, "coords": [[float(p[0]), float(p[1])] for p in coords]}
        for bbl, coords in rows
    ]
