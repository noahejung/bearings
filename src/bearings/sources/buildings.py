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

import math

import duckdb
import pandas as pd

from bearings import config, duckconn, staleness
from bearings.sources import hpd, pluto, socrata

SOURCE = {
    "name": "NYC Building Footprints",
    "url": "https://data.cityofnewyork.us/d/5zhs-2jue",
}

# How far apart the footprints sharing one BBL may sit before this module
# refuses to name a single point for that BBL. See point_for_bbl() for the
# measurement behind it.
MAX_BBL_FOOTPRINT_SPREAD_M = 500.0

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


def fetch_footprints() -> pd.DataFrame:
    """Every real building footprint citywide, as a flat DataFrame ready to
    bake to Parquet: `ord`, bbl, the exterior ring as two FLAT `lats`/`lngs`
    columns, and a precomputed min/max lat/lng bbox for fast row-group
    pruning later.

    **Geometry is two flat LIST<DOUBLE> columns, not one nested
    LIST<LIST<DOUBLE>> `coords` column, and that is a measurement, not a
    style choice.** DuckDB's Python conversion of a doubly-nested LIST
    allocates a large transient buffer per query; a single-level LIST does
    not. sources/gtfs.py's _baked_shapes_frame() found the same thing for
    the (much smaller) subway-shapes file on 2026-09-07; this is that same
    change applied to the two big files. Measured 2026-09-07 in a real
    `docker run --memory=512m --memory-swap=512m` container (cgroup v2
    accounting, the way Render's own 512MB cap is enforced -- see this
    repo's agent-report for the full table): with the nested column, six
    sequential GET /api/map calls returned HTTP 500 every single time,
    because DuckDB refuses the allocation against the 409.5 MiB
    memory_limit it derives from the 512MB cgroup, and three concurrent
    light-browsing clients got the container OOM-killed outright (exit
    137). With flat columns the identical drive completes.

    `ord` is the bake order, and it exists so footprints_in_bbox() can
    ORDER BY it -- without it that function's LEFT JOIN has no ordering
    guarantee at all, so two identical GET /api/map requests could return
    the same buildings in a different order. See its own docstring.

    `order=":id"` on the paginated fetch is the fix for the duplicate rows
    the 2026-07-14 bake carried; sources/socrata.py's fetch() docstring has
    the mechanism and the measurement.
    """
    raw = socrata.fetch(
        "buildings", select="the_geom,base_bbl", where=_STATUS_FILTER, order=":id"
    )

    ords: list[int] = []
    bbls: list[str | None] = []
    lats_col: list[list[float]] = []
    lngs_col: list[list[float]] = []
    min_lats: list[float] = []
    max_lats: list[float] = []
    min_lngs: list[float] = []
    max_lngs: list[float] = []

    for row in raw.itertuples():
        coords = _ring_coords(row.the_geom)
        if coords is None:
            continue
        lats = [p[0] for p in coords]
        lngs = [p[1] for p in coords]
        bbl = row.base_bbl if isinstance(row.base_bbl, str) else None
        ords.append(len(ords))
        bbls.append(bbl)
        lats_col.append(lats)
        lngs_col.append(lngs)
        min_lats.append(min(lats))
        max_lats.append(max(lats))
        min_lngs.append(min(lngs))
        max_lngs.append(max(lngs))

    return pd.DataFrame(
        {
            "ord": ords,
            "bbl": bbls,
            "lats": lats_col,
            "lngs": lngs_col,
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
        staleness.require_baked_columns(
            _PATH, {"ord", "lats", "lngs"}, "baked building footprints"
        )
    else:
        _write_parquet(fetch_footprints(), _PATH)

    if _ATTR_PATH.exists():
        staleness.warn_if_stale(
            _ATTR_PATH, config.BUILDING_ATTRIBUTES_CACHE_MAX_AGE_S, "building attributes"
        )
    else:
        _write_parquet(fetch_attributes(), _ATTR_PATH)


def _spread_m(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> float:
    """The diagonal of a lat/lng box, in metres. Equirectangular rather than
    haversine: this is used only to decide whether a group of footprints is
    plausibly one building lot or obviously not, and at NYC's latitude over
    box sizes of metres-to-kilometres the two agree to well within the
    precision that decision needs."""
    mid_lat = math.radians((min_lat + max_lat) / 2)
    dy = (max_lat - min_lat) * 111_320.0
    dx = (max_lng - min_lng) * 111_320.0 * math.cos(mid_lat)
    return math.hypot(dx, dy)


def point_for_bbl(bbl: str) -> tuple[float, float] | None:
    """One real (lat, lng) for a BBL, taken from its own baked footprint(s),
    or `None` when this file cannot name one honestly.

    Two per-point sources in this codebase -- FEMA's flood zone and DOT's
    pavement rating -- are queried by point, not by BBL, so the per-building
    endpoint (bearings.buildingrecord) needs a way to turn the BBL it was
    asked about into a point. This is that way, and it refuses in two real,
    measured cases rather than returning a plausible wrong answer:

    1. **No footprint carries this BBL.** Measured 2026-09-07 against the
       baked file: 53,904 of PLUTO's 858,602 lots have no footprint row at
       all, and one of them is a fixture this repo already tests against --
       346 East 4 St, Manhattan (bbl 1003730026), a real building with four
       real rodent inspections on record. There is no point to hand FEMA
       for it, and inventing one from the block would be a different
       building's answer.

    2. **The BBL is a placeholder shared by scattered buildings.** The
       footprint dataset's `base_bbl` is not unique: 816,102 distinct BBLs
       cover 1,079,670 footprints, and 23 unrelated footprints citywide
       carry `3999999999` (borough 3, block 99999, lot 9999 -- DOB's own
       unknown-lot placeholder), spanning 40.5716-40.7333 latitude, roughly
       18 km. A centroid over that group is a perfectly-computed,
       completely-wrong point. Refused, loudly, by
       MAX_BBL_FOOTPRINT_SPREAD_M -- the same "guard, don't guess" shape as
       transit.py's AnchorSnapTooFar, which exists because an anchor once
       silently snapped to a subway station 2.3 km away.

       500 m is picked against what the point is *for*: pavement.near()'s
       own default query radius is 250 m, so a group already spread wider
       than twice that radius cannot be represented by any one point at the
       resolution these two sources answer at. Normal lots are far below
       it: 597,339 BBLs carry exactly one footprint and 210,165 carry two
       (a house and its garage, a building and its annex).

    A BBL that passes both checks gets the centre of its footprints' union
    bounding box -- a point on its own lot. Confirmed live 2026-09-07
    against 161 Newel St, Greenpoint (bbl 3026230011): this returns
    (40.72773, -73.94927) against the bedbug dataset's own published
    latitude/longitude for the same building, (40.72768, -73.94903) -- 21 m
    apart, well inside the resolution either consumer works at.

    Returns `None`, never raises, because "we could not name a point" is a
    normal state the caller has to render honestly ("unavailable"), not an
    error -- but it is a state the caller must be able to *see*, which is
    why it is `None` and not a silently-plausible pair of floats.
    """
    if not _PATH.exists():
        raise FileNotFoundError(
            f"{_PATH} has not been baked yet -- call bearings.sources.buildings."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    con = duckconn.connect()
    try:
        row = con.execute(
            f"""
            SELECT count(*), min(min_lat), max(max_lat), min(min_lng), max(max_lng)
            FROM read_parquet('{_PATH.as_posix()}')
            WHERE bbl = ?
            """,
            [bbl],
        ).fetchone()
    finally:
        con.close()

    if row is None or not row[0]:
        return None
    _, min_lat, max_lat, min_lng, max_lng = row
    if _spread_m(min_lat, max_lat, min_lng, max_lng) > MAX_BBL_FOOTPRINT_SPREAD_M:
        return None
    return ((min_lat + max_lat) / 2, (min_lng + max_lng) / 2)


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

    Geometry comes back out of two flat `lats`/`lngs` LIST<DOUBLE> columns
    and is zipped into the same [[lat, lng], ...] shape this function has
    always returned -- the JSON contract at GET /api/map is unchanged, only
    the on-disk representation moved. See fetch_footprints()' docstring for
    the measured reason. `strict=True` on that zip is deliberate, matching
    gtfs.shape_candidates_in_bbox(): the two columns are written from the
    same coordinate list and must stay the same length, so a silent
    truncation to the shorter of the two would draw a real building's
    outline short rather than fail.

    `ORDER BY ord` is what makes two identical requests byte-identical.
    Without it this query had no ordering guarantee whatsoever -- DuckDB is
    free to return a LEFT JOIN's rows in whatever order its hash join
    produces, which varies with thread count and scheduling -- so GET
    /api/map was not deterministic across two identical calls. That is
    invisible on screen (the map draws the same buildings either way) and
    exactly the kind of thing that makes a before/after payload diff
    useless, which is how it was found.
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
    con = duckconn.connect()
    try:
        rows = con.execute(
            f"""
            SELECT b.bbl, b.lats, b.lngs, a.year_built, a.era, a.residential,
                   a.hazard_class_c
            FROM read_parquet('{_PATH.as_posix()}') b
            LEFT JOIN read_parquet('{_ATTR_PATH.as_posix()}') a ON b.bbl = a.bbl
            WHERE b.max_lat >= ? AND b.min_lat <= ? AND b.max_lng >= ? AND b.min_lng <= ?
            ORDER BY b.ord
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "bbl": bbl,
            "coords": [[float(a), float(b)] for a, b in zip(lats, lngs, strict=True)],
            "year_built": int(year_built) if year_built is not None else None,
            "era": era,
            "residential": bool(residential) if residential is not None else None,
            "hazard_class_c": int(hazard_class_c) if hazard_class_c is not None else None,
        }
        for bbl, lats, lngs, year_built, era, residential, hazard_class_c in rows
    ]
