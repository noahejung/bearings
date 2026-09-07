"""NYC street centrelines -- the ink "hairline" layer under the map's H3
cells and subway lines (VISUAL.md §5's hybrid base: "Streets ... Ink
hairlines on top, weighted by road class").

See buildings.py's module docstring for the shared build-time-bake /
request-time-bbox-slice rationale; this module follows the exact same
shape, at a much smaller scale.

Confirmed live 2026-07-14 against data.cityofnewyork.us/resource/inkn-q76z
("Centerline" -- NYC Street Centerline / CSCL, the current, non-404
dataset; an older "current version" link in a sibling dataset's own
description (`exjm-f27b`) 404s and is stale):
  - `$select=count(*)` -> 122,245 segments citywide -- two orders of
    magnitude smaller than the building-footprint dataset, bakes in well
    under a minute.
  - `the_geom` is a GeoJSON MultiLineString. A 5,000-row sample: ~96% of
    segments have exactly one part, but some (an intersection-spanning
    segment) have several, up to 11 in the sample -- every part is kept
    and rendered as its own line (mapgeo.py's `_subway_lines()` already
    draws one path per GTFS shape the same way, rather than merging
    shapes).
  - Road-class weighting is derived from two live-verified fields rather
    than an assumed code table: `rw_type=='2'` is NYC's CSCL code for a
    highway -- confirmed by querying real segments (Henry Hudson Pkwy,
    Clearview Expy, Major Deegan Expy, Brooklyn-Queens Expy all return
    rw_type='2'). `rw_type=='14'` is a ferry route -- confirmed the same
    way (e.g. "DUMBO-RED HOOK FERRY RTE", "WFC-WALL STREET FERRY RTE") --
    water, not pavement, and excluded entirely rather than drawn as a
    street. Every other rw_type is rendered; its rank among those is
    scaled by `number_total_lanes`, a directly-measured numeric field, so
    no further unverified rw_type semantics are needed.
"""

from pathlib import Path

import duckdb
import pandas as pd

from bearings import config, duckconn, staleness
from bearings.sources import socrata

SOURCE = {
    "name": "NYC Street Centerline (CSCL)",
    "url": "https://data.cityofnewyork.us/d/inkn-q76z",
}

_PATH = config.DERIVED_DIR / "streets.parquet"

_HIGHWAY_RW_TYPE = "2"
_FERRY_RW_TYPE = "14"

# Matches the approved prototype's four-tier road-class weighting
# (scratchpad/bearings-map.html: stroke-width [0.28, 0.55, 1.0, 1.65],
# stroke-opacity [0.3, 0.62, 0.85, 1] indexed by rank).
RANK_HIGHWAY = 3
RANK_ARTERIAL = 2
RANK_COLLECTOR = 1
RANK_LOCAL = 0


def _rank(rw_type: str | None, lanes: float) -> int:
    if rw_type == _HIGHWAY_RW_TYPE:
        return RANK_HIGHWAY
    if lanes >= 5:
        return RANK_ARTERIAL
    if lanes >= 3:
        return RANK_COLLECTOR
    return RANK_LOCAL


def _line_parts(the_geom: dict | None) -> list[list[list[float]]]:
    """Every part of a segment's MultiLineString, as [[lat, lng], ...]
    each -- see the module docstring for why every part is kept rather
    than only the first."""
    if not isinstance(the_geom, dict):
        return []
    try:
        parts = the_geom["coordinates"]
    except (KeyError, TypeError):
        return []
    out: list[list[list[float]]] = []
    for part in parts:
        if len(part) >= 2:
            out.append([[float(lat), float(lng)] for lng, lat in part])
    return out


def fetch_centerlines() -> pd.DataFrame:
    """Every real street-centreline part citywide (ferry routes excluded),
    as a flat DataFrame ready to bake to Parquet: `ord`, physicalid, the
    part's geometry as two FLAT `lats`/`lngs` columns, a live-derived
    road-class rank, and a precomputed min/max lat/lng bbox for fast
    row-group pruning later.

    Flat `lats`/`lngs` LIST<DOUBLE> columns rather than one nested
    LIST<LIST<DOUBLE>> `coords` column, and `order=":id"` on the paginated
    fetch, for exactly the reasons sources/buildings.py's own
    fetch_footprints() docstring gives -- same change, same measurement,
    same wave. `ord` is the bake order, so segments_in_bbox() can ORDER BY
    it and be byte-deterministic across two identical requests.
    """
    raw = socrata.fetch(
        "centerlines",
        select="the_geom,physicalid,rw_type,number_total_lanes",
        where=f"rw_type != '{_FERRY_RW_TYPE}'",
        order=":id",
    )

    ords: list[int] = []
    physicalids: list[str] = []
    lats_col: list[list[float]] = []
    lngs_col: list[list[float]] = []
    ranks: list[int] = []
    min_lats: list[float] = []
    max_lats: list[float] = []
    min_lngs: list[float] = []
    max_lngs: list[float] = []

    for row in raw.itertuples():
        try:
            lanes = float(row.number_total_lanes)
        except (TypeError, ValueError):
            lanes = 0.0
        rank = _rank(row.rw_type, lanes)

        for part in _line_parts(row.the_geom):
            lats = [p[0] for p in part]
            lngs = [p[1] for p in part]
            ords.append(len(ords))
            physicalids.append(row.physicalid)
            lats_col.append(lats)
            lngs_col.append(lngs)
            ranks.append(rank)
            min_lats.append(min(lats))
            max_lats.append(max(lats))
            min_lngs.append(min(lngs))
            max_lngs.append(max(lngs))

    return pd.DataFrame(
        {
            "ord": ords,
            "physicalid": physicalids,
            "lats": lats_col,
            "lngs": lngs_col,
            "rank": ranks,
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
    """Bake data/derived/streets.parquet if it doesn't already exist. See
    buildings.warm_cache()'s docstring -- same shape, much smaller (122k
    segments vs. ~1.08M footprints), bakes in well under a minute."""
    if _PATH.exists():
        staleness.warn_if_stale(_PATH, config.CENTERLINES_CACHE_MAX_AGE_S, "street centrelines")
        staleness.require_baked_columns(
            _PATH, {"ord", "lats", "lngs"}, "baked street centrelines"
        )
        return
    _write_parquet(fetch_centerlines(), _PATH)


def segments_in_bbox(bbox: dict) -> list[dict]:
    """Every baked street-centreline part whose bounding box overlaps
    `bbox`, as {"physicalid": str, "coords": [[lat,lng],...], "rank": int}.

    Requires warm_cache() to have baked the Parquet file first -- raises
    FileNotFoundError otherwise, matching buildings.footprints_in_bbox()'s
    loud-guard behaviour.

    Reads the two flat `lats`/`lngs` columns and zips them back into the
    same [[lat, lng], ...] shape this function has always returned -- the
    GET /api/map JSON contract is unchanged, only the on-disk
    representation moved (see fetch_centerlines()). `ORDER BY ord` makes
    two identical requests byte-identical; `strict=True` on the zip makes a
    length mismatch between the two columns fail loudly instead of drawing
    a real street short.
    """
    if not _PATH.exists():
        raise FileNotFoundError(
            f"{_PATH} has not been baked yet -- call bearings.sources.streets."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    con = duckconn.connect()
    try:
        rows = con.execute(
            f"""
            SELECT physicalid, lats, lngs, rank FROM read_parquet('{_PATH.as_posix()}')
            WHERE max_lat >= ? AND min_lat <= ? AND max_lng >= ? AND min_lng <= ?
            ORDER BY ord
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "physicalid": pid,
            "coords": [[float(a), float(b)] for a, b in zip(lats, lngs, strict=True)],
            "rank": int(rank),
        }
        for pid, lats, lngs, rank in rows
    ]
