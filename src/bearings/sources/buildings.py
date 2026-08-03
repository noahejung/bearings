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
from bearings.sources import hpd, pluto, socrata

SOURCE = {
    "name": "NYC Building Footprints",
    "url": "https://data.cityofnewyork.us/d/5zhs-2jue",
}

_PATH = config.DERIVED_DIR / "buildings.parquet"
# Per-building attribute join (LAYOUT-V3 WAVE 1e, SPEC-layout-v3.md §8, Noah:
# "what's stopping us from searching up every livable building and mapping
# that out") -- bbl -> (year_built, era, residential, hazard_class_c), baked
# once from the same two citywide sources cellprofile.py's own cell-level
# building-age/hazard aggregate already fetches (pluto.citywide_land_use(),
# hpd.citywide_open_class_c_counts()), then LEFT JOINed onto the bbox-scoped
# footprints in footprints_in_bbox() below by the exact same 10-char
# boro+block+lot bbl both PLUTO and this dataset's own base_bbl already
# share (see this module's own docstring). Deliberately a second, separate
# fetch of those two citywide datasets rather than sharing cellprofile.py's
# -- no cross-bake fetch-sharing infrastructure exists anywhere in this
# codebase yet, and building one felt like real scope creep for this wave;
# each bake pays its own real network cost once and is cached to disk
# forever after, same as everything else here.
_ATTR_PATH = config.DERIVED_DIR / "building_attributes.parquet"

# See pluto.py's own _RESIDENTIAL_LANDUSE_CODES docstring for the four
# codes and why "4" (mixed residential & commercial) is folded in.

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


def fetch_attributes() -> pd.DataFrame:
    """Every PLUTO lot's bbl -> (year_built, era, residential,
    hazard_class_c) -- the per-building attribute table LEFT JOINed onto
    the footprint geometry in footprints_in_bbox() below.

    `year_built`/`era` reuse pluto.py's own 0-means-"not recorded" sentinel
    (mapped to `None` here, never a guessed year -- same rule pluto.building()
    already enforces). `residential` is pluto._is_residential() applied to
    the lot's own landuse code (`None`, not a guessed bool, when landuse
    itself is missing). `hazard_class_c` reuses the exact open Class C
    ("immediately hazardous") HPD count cellprofile.py's own cell-level
    hazard aggregate already computes citywide
    (hpd.citywide_open_class_c_counts()), joined the identical way that
    module joins it: boro/block/lot via hpd._bbl_parts(), not a re-padded
    bbl string (HPD carries no bbl column of its own -- see hpd.py's module
    docstring). Defaults to a real `0` (not `None`) for a lot with a bbl but
    no matching Class C row -- "we looked and found zero," this codebase's
    own None-vs-0 rule, exactly as hpd.open_violations() already does for
    a single building.
    """
    lots = pluto.citywide_land_use()
    hazard_raw = hpd.citywide_open_class_c_counts()
    hazard_lookup: dict[tuple[str, str, str], int] = {
        (row.boroid, row.block, row.lot): int(row.count) for row in hazard_raw.itertuples()
    }

    bbls: list[str] = []
    years: list[int | None] = []
    eras: list[str | None] = []
    residentials: list[bool | None] = []
    hazards: list[int] = []

    for row in lots.itertuples():
        bbls.append(row.bbl)
        year = int(row.year_built)
        years.append(year if year > 0 else None)
        eras.append(pluto._era(year) if year > 0 else None)
        residentials.append(pluto._is_residential(row.landuse))
        boro, block, lot = hpd._bbl_parts(row.bbl)
        hazards.append(hazard_lookup.get((boro, block, lot), 0))

    return pd.DataFrame(
        {
            "bbl": bbls,
            "year_built": years,
            "era": eras,
            "residential": residentials,
            "hazard_class_c": hazards,
        }
    )


def _write_parquet(df: pd.DataFrame, path: Path) -> None:
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.register("_df", df)
    con.execute(f"COPY _df TO '{path.as_posix()}' (FORMAT PARQUET)")
    con.close()


def warm_cache() -> None:
    """Bake data/derived/buildings.parquet AND data/derived/
    building_attributes.parquet if either doesn't already exist. Called
    once by Dockerfile's build-time step (and by api.py's startup handler,
    mirroring profile.py's own POI-table pattern, so local dev gets the
    same warm-boot-after-first-run behaviour). Real cost the first time:
    ~207s of footprint pagination (see module docstring) PLUS the PLUTO/HPD
    citywide fetches fetch_attributes() pays (comparable to
    cellprofile.py's own bake -- tens of seconds to low minutes). Safe to
    call more than once -- a no-op once both files exist."""
    if _PATH.exists():
        staleness.warn_if_stale(_PATH, config.BUILDINGS_CACHE_MAX_AGE_S, "building footprints")
    else:
        _write_parquet(fetch_footprints(), _PATH)

    if _ATTR_PATH.exists():
        staleness.warn_if_stale(
            _ATTR_PATH, config.BUILDING_ATTRIBUTES_CACHE_MAX_AGE_S, "building attributes"
        )
    else:
        _write_parquet(fetch_attributes(), _ATTR_PATH)


def footprints_in_bbox(bbox: dict) -> list[dict]:
    """Every baked building footprint whose bounding box overlaps `bbox`,
    each carrying its own real per-building attributes (LAYOUT-V3 WAVE 1e):
    {"bbl": str|None, "coords": [[lat,lng],...], "year_built": int|None,
    "era": str|None, "residential": bool|None, "hazard_class_c": int|None}.

    `year_built`/`era`/`residential`/`hazard_class_c` are all `None` for a
    footprint with no bbl, or whose bbl has no matching PLUTO/HPD lot (a
    real, honest "no record," never a guessed default) -- EXCEPT
    `hazard_class_c`, which fetch_attributes() already resolves to a real
    `0` for any lot that DOES have a PLUTO/HPD match but no open Class C
    violation; only a footprint with no matching lot at all sees `None`
    here.

    Requires warm_cache() to have baked BOTH Parquet files first -- raises
    FileNotFoundError otherwise (a loud, named guard) rather than silently
    returning an empty/unattributed layer that looks like "no buildings
    here" or "no record for this real building" instead of "not baked yet".
    """
    if not _PATH.exists():
        raise FileNotFoundError(
            f"{_PATH} has not been baked yet -- call bearings.sources.buildings."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    if not _ATTR_PATH.exists():
        raise FileNotFoundError(
            f"{_ATTR_PATH} has not been baked yet -- call bearings.sources.buildings."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            SELECT b.bbl, b.coords, a.year_built, a.era, a.residential, a.hazard_class_c
            FROM read_parquet('{_PATH.as_posix()}') b
            LEFT JOIN read_parquet('{_ATTR_PATH.as_posix()}') a ON b.bbl = a.bbl
            WHERE b.max_lat >= ? AND b.min_lat <= ? AND b.max_lng >= ? AND b.min_lng <= ?
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "bbl": bbl,
            "coords": [[float(p[0]), float(p[1])] for p in coords],
            "year_built": int(year_built) if year_built is not None else None,
            "era": era,
            "residential": bool(residential) if residential is not None else None,
            "hazard_class_c": int(hazard_class_c) if hazard_class_c is not None else None,
        }
        for bbl, coords, year_built, era, residential, hazard_class_c in rows
    ]
