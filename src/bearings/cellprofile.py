"""Per-cell (H3 res-9) block-level profile precompute -- Phase 1 of
SPEC-precompute-v2.md ("the whole city is a 40MB file", finally built).

Why this module exists: /api/profile computes everything live, per
request, and on Render's 0.1-CPU free tier that is measured at 6-10s cold
(SPEC-precompute-v2.md, 2026-07-15). /api/citywide is precomputed and
measured at 0.14s. The fix for both "load a report in <1s" and "click any
hex to swap the report to that location" is the same fix: precompute a
report-ready profile for every real H3 res-9 cell citywide, once, at build
time, and serve it as a flat lookup (this module's `profile_for()`) instead
of computing it per request.

**What "every real cell" means, and how it's decided -- data-derived, not a
bounding box.** NYC_BBOX is a rectangle that includes open water (Long
Island Sound, the Upper Bay, a slice of New Jersey) -- enumerating H3 cells
across that rectangle at res-9 would produce roughly 24,500 cells, most of
them empty ocean. Instead, a cell counts as real if at least one NYC
building footprint (buildings.parquet, already baked citywide) has its
centre inside it -- confirmed live 2026-07-15: 7,021 such cells, closely
matching this project's own long-cited "~7,400 res-9 cells citywide"
estimate. This is a defensible, data-grounded definition ("does anyone live
or work in this cell"), not an arbitrary shape.

**Per-cell metrics, and where each number comes from:**
  - `noise`: real 311 noise-complaint counts in the trailing 12 months,
    bucketed into this cell specifically (not mapgeo.py's 700m/37-cell
    disk around a searched address -- this is the cell's own count).
  - `amenities`: real Overture daily-life POI counts, read from the
    already-baked pois.parquet (same 8 categories api.py's report card and
    mapgeo.py's metric dropdown already use).
  - `trees`: real living-street-tree counts in this cell.
  - `building_age`: the real median PLUTO `yearbuilt` of every lot centred
    in this cell, or `None` if none has a recorded year -- never a
    fabricated single-lot answer standing in for the whole cell.
  - `transit`: stations within TRANSIT_ACCESS_RADIUS_M of the cell's own
    centroid (mapgeo.py's same proxy metric), PLUS a real per-cell commute:
    the nearest NEAREST_STATION_COUNT stations from the cell centroid, fed
    through the already-baked anchor-times table (profile.py's
    `_anchor_times()` -- one Dijkstra run per anchor, done once, memoised)
    exactly the way profile.py's own `_to_anchors()` does for a single
    address. This is NOT a new Dijkstra per cell -- it's the same cheap
    nearest-station lookup profile.py already does, run ~7,000 times
    instead of once, which is why per-cell commute was cheap enough to
    include rather than deferred (see SPEC-precompute-v2.md's own "measure
    the build-time cost" instruction for Phase 1's commute task).
  - `safety`: this cell's NYPD precinct (batched spatial join, see
    sources/precincts.py's `precincts_for_points()`) and that precinct's
    already-baked crime percentile (citywide.py) -- `None` if the cell's
    centroid resolves to no precinct (open water, a gap at a simplified
    boundary edge).
  - `housing_hazards`: real, aggregated open Class C ("immediately
    hazardous") HPD violation counts for every PLUTO lot centred in this
    cell -- deliberately Class C only (hpd.py's own docstring: "the number
    that matters"), and deliberately NOT heat/rodent/bedbug data (see
    "Deliberately NOT precomputed" below).

**Deliberately NOT precomputed, and why (both real, stated gaps, not
silent omissions):**
  - `flood`: FEMA's NFHL is a single-point-at-a-time ArcGIS service with a
    live-confirmed ~30-50% transient-failure rate and up to 5 retries per
    point (sources/flood.py's own docstring) -- mapgeo.py already rejected
    querying this per cell for a *single address's* 37-cell disk on these
    grounds. At ~7,000 cells citywide, even paid once at build time, the
    same failure rate would add on the order of hours (not minutes) to a
    Docker build in the worst case -- not attempted this pass. Flagged
    explicitly in the report, not fabricated as an absent-but-present key.
  - heat/rodent/bedbug complaints: per-building, voluntarily-filed
    complaint data -- mapgeo.py's own module docstring already states why
    these should never shade a cell: a quiet cell could mean "no problem"
    or "nobody filed a complaint here," and this project's own rule
    against fabricated citywide surfaces forbids treating those the same.
    HPD violations (this module's `housing_hazards`) are a materially
    different data class worth stating plainly: a violation is only
    entered after an HPD inspection finds a real code violation, not
    merely that someone called -- a real (if still imperfect: inspection
    intensity varies too) step up from a raw complaint count.
"""

import json
import statistics
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import duckdb

from bearings import cells as cellslib
from bearings import citywide, config, profile, staleness
from bearings.mapgeo import AMENITY_CATEGORIES, TRANSIT_ACCESS_RADIUS_M
from bearings.sources import buildings, compstat, hpd, noise, overture, pluto, precincts, socrata
from bearings.sources import trees as trees_source
from bearings.transit import SOURCE as TRANSIT_SOURCE
from bearings.transit import TRANSIT_CAVEAT, WALK_SPEED_MPS, _haversine_m

_CELLS_DIR = config.DERIVED_DIR / "cells"
_MANIFEST_PATH = _CELLS_DIR / "_manifest.json"

_NOISE_WINDOW_DAYS = 365

HAZARD_NOTE = (
    "Open Class C (\"immediately hazardous\") HPD violations only, summed "
    "across every tax lot centred in this cell -- a violation is entered "
    "only after an HPD inspection confirms a real code violation, which is "
    "a step up from a raw, unverified complaint. Still reflects inspection "
    "and reporting intensity, not necessarily every real issue: a 0 here "
    "means no verified open hazard on record, not that none could exist."
)


def _shard_path(shard: str) -> Path:
    return _CELLS_DIR / f"{shard}.json"


def all_cells() -> list[str]:
    """Every real H3 res-9 cell citywide -- see the module docstring for
    exactly how "real" is decided (at least one baked building footprint
    centred inside it). Requires buildings.warm_cache() to have baked
    buildings.parquet first -- raises FileNotFoundError otherwise, matching
    every other not-baked-yet guard in this codebase."""
    if not buildings._PATH.exists():
        raise FileNotFoundError(
            f"{buildings._PATH} has not been baked yet -- call bearings.sources."
            "buildings.warm_cache() first."
        )
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            SELECT DISTINCT (min_lat + max_lat) / 2 AS lat, (min_lng + max_lng) / 2 AS lng
            FROM read_parquet('{buildings._PATH.as_posix()}')
            """
        ).fetchall()
    finally:
        con.close()
    return sorted({cellslib.cell_for(lat, lng) for lat, lng in rows})


def _safe_cell_for(lat: float, lng: float) -> str | None:
    """cellslib.cell_for(), tolerant of the occasional out-of-domain record
    a citywide fetch of hundreds of thousands of rows is bound to contain
    (a bad (0.0, 0.0) sentinel, a NaN, a typo'd coordinate past +-90/+-180)
    -- h3-py raises H3LatLngDomainError for those rather than returning a
    nonsense cell, confirmed live 2026-07-15 against the real 311 noise
    feed. One bad row must not kill an otherwise-good multi-hundred-
    thousand-row bake; it is simply not counted anywhere (never bucketed
    into a real cell it doesn't actually belong to)."""
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        return None
    try:
        return cellslib.cell_for(lat, lng)
    except Exception:  # noqa: BLE001 -- see docstring: one bad row, not a crash
        return None


def _noise_by_cell(cell_ids: list[str]) -> dict[str, int]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_NOISE_WINDOW_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    where = f"complaint_type like 'Noise%' AND created_date > '{cutoff}'"
    df = socrata.fetch("311", select="latitude,longitude", where=where)
    counts = {c: 0 for c in cell_ids}
    for row in df.itertuples():
        try:
            lat, lng = float(row.latitude), float(row.longitude)
        except (TypeError, ValueError):
            continue
        cell = _safe_cell_for(lat, lng)
        if cell in counts:
            counts[cell] += 1
    return counts


def _trees_by_cell(cell_ids: list[str]) -> dict[str, int]:
    pts = trees_source.citywide_points()
    counts = {c: 0 for c in cell_ids}
    for lat, lng in zip(pts["lat"], pts["lng"], strict=True):
        cell = _safe_cell_for(lat, lng)
        if cell in counts:
            counts[cell] += 1
    return counts


def _amenities_by_cell(cell_ids: list[str]) -> dict[str, dict[str, int]]:
    pois_path = config.DERIVED_DIR / "pois.parquet"
    if not pois_path.exists():
        raise FileNotFoundError(
            f"{pois_path} has not been baked yet -- call bearings.profile."
            "warm_caches() first."
        )
    con = duckdb.connect()
    try:
        placeholders = ",".join("?" for _ in AMENITY_CATEGORIES)
        rows = con.execute(
            f"""
            SELECT cell, category, count(*) AS n
            FROM read_parquet('{pois_path.as_posix()}')
            WHERE category IN ({placeholders})
            GROUP BY cell, category
            """,
            AMENITY_CATEGORIES,
        ).fetchall()
    finally:
        con.close()
    out = {c: {cat: 0 for cat in AMENITY_CATEGORIES} for c in cell_ids}
    for cell, cat, n in rows:
        if cell in out:
            out[cell][cat] = int(n)
    return out


def _building_age_and_hazards_by_cell(
    cell_ids: list[str],
) -> tuple[dict[str, float | None], dict[str, int], float | None]:
    """Median PLUTO building age AND aggregated open-Class-C HPD hazard
    counts, computed together -- both need the same PLUTO
    lot -> (lat, lng, boro/block/lot) walk, so it is done once, not twice.
    Returns (median_year_by_cell, hazard_count_by_cell, pluto_join_hit_rate)
    -- the hit rate is a real, reportable number (not every HPD lot key
    resolves a PLUTO lat/lng), never silently assumed to be 100%.
    """
    cell_set = set(cell_ids)
    pts = pluto.citywide_points()
    hazard_raw = hpd.citywide_open_class_c_counts()
    hazard_lookup: dict[tuple[str, str, str], int] = {
        (row.boroid, row.block, row.lot): int(row.count) for row in hazard_raw.itertuples()
    }

    years_by_cell: dict[str, list[int]] = {c: [] for c in cell_ids}
    hazard_by_cell: dict[str, int] = {c: 0 for c in cell_ids}
    matched_keys: set[tuple[str, str, str]] = set()

    for row in pts.itertuples():
        cell = _safe_cell_for(row.lat, row.lng)
        if cell not in cell_set:
            continue
        if row.year_built > 0:
            years_by_cell[cell].append(int(row.year_built))
        boro, block, lot = hpd._bbl_parts(row.bbl)
        key = (boro, block, lot)
        n = hazard_lookup.get(key)
        if n:
            hazard_by_cell[cell] += n
            matched_keys.add(key)

    median_by_cell = {
        c: (float(statistics.median(years)) if years else None)
        for c, years in years_by_cell.items()
    }
    hit_rate = len(matched_keys) / len(hazard_lookup) if hazard_lookup else None
    return median_by_cell, hazard_by_cell, hit_rate


def _transit_by_cell(
    cell_ids: list[str], centroids: dict[str, tuple[float, float]]
) -> dict[str, dict]:
    stations_df = profile._stations()
    anchor_times = profile._anchor_times()
    station_list = [
        (row.stop_id, row.lat, row.lng) for row in stations_df.itertuples()
    ]

    out: dict[str, dict] = {}
    for c in cell_ids:
        lat, lng = centroids[c]
        nearby: list[tuple[float, str]] = []
        for stop_id, slat, slng in station_list:
            d = _haversine_m((lat, lng), (slat, slng))
            if d <= profile.STATION_SEARCH_M:
                nearby.append((d, stop_id))
        access = sum(1 for d, _ in nearby if d <= TRANSIT_ACCESS_RADIUS_M)
        nearby.sort(key=lambda t: t[0])
        nearest = nearby[: profile.NEAREST_STATION_COUNT]

        to_anchors: dict[str, int] = {}
        for anchor, by_stop in anchor_times.items():
            best: int | None = None
            for d, stop_id in nearest:
                ride_s = by_stop.get(stop_id)
                if ride_s is None:
                    continue
                total = int(round(d / WALK_SPEED_MPS / 60)) + int(round(ride_s / 60))
                if best is None or total < best:
                    best = total
            to_anchors[anchor] = best if best is not None else -1

        out[c] = {"access": access, "to_anchors": to_anchors}
    return out


def _building_age_block(median_year: float | None) -> dict:
    if median_year is None:
        return {"median_year_built": None, "era": None, "source": dict(pluto.SOURCE)}
    return {
        "median_year_built": median_year,
        "era": pluto._era(int(round(median_year))),
        "source": dict(pluto.SOURCE),
    }


def _bake_all() -> dict:
    """Assemble every real cell's profile and write it to
    data/derived/cells/<res6-shard>.json, plus a manifest recording what
    got baked. Returns the manifest dict (also what gets written to disk)."""
    cell_ids = all_cells()
    centroids = {c: cellslib.centroid(c) for c in cell_ids}

    noise_counts = _noise_by_cell(cell_ids)
    tree_counts = _trees_by_cell(cell_ids)
    amenity_counts = _amenities_by_cell(cell_ids)
    age_median, hazard_counts, pluto_hit_rate = _building_age_and_hazards_by_cell(cell_ids)
    transit_by_cell = _transit_by_cell(cell_ids, centroids)

    precinct_by_cell = precincts.precincts_for_points(
        [(c, centroids[c][0], centroids[c][1]) for c in cell_ids]
    )
    precinct_crime = {p["precinct"]: p["crime"] for p in citywide.get()["precincts"]}

    profiles: dict[str, dict] = {}
    for c in cell_ids:
        pct = precinct_by_cell.get(c)
        crime = precinct_crime.get(pct) if pct is not None else None
        lat, lng = centroids[c]
        profiles[c] = {
            "h3": c,
            "shard": cellslib.shard_for(c),
            "centroid": {"lat": lat, "lng": lng},
            "noise": {
                "complaints_12mo": noise_counts.get(c, 0),
                "source": dict(noise.SOURCE),
            },
            "amenities": {
                "counts": amenity_counts.get(c, {cat: 0 for cat in AMENITY_CATEGORIES}),
                "source": dict(overture.SOURCE),
            },
            "trees": {
                "street_trees": tree_counts.get(c, 0),
                "source": dict(trees_source.SOURCE),
            },
            "building_age": _building_age_block(age_median.get(c)),
            "transit": {
                "stations_within_500m": transit_by_cell[c]["access"],
                "to_anchors": transit_by_cell[c]["to_anchors"],
                "caveat": TRANSIT_CAVEAT,
                "source": dict(TRANSIT_SOURCE),
            },
            "safety": {
                "precinct": pct,
                "crime": crime,
                "crime_caveat": citywide.CRIME_RELATIVE_CAVEAT,
                "source": dict(compstat.SOURCE),
            },
            "housing_hazards": {
                "class_c_violations": hazard_counts.get(c, 0),
                "note": HAZARD_NOTE,
                "source": dict(hpd.SOURCE),
            },
        }

    by_shard: dict[str, dict[str, dict]] = {}
    for c, prof in profiles.items():
        by_shard.setdefault(prof["shard"], {})[c] = prof

    _CELLS_DIR.mkdir(parents=True, exist_ok=True)
    for shard, cell_map in by_shard.items():
        _shard_path(shard).write_text(json.dumps(cell_map))

    manifest = {
        "cell_count": len(profiles),
        "shard_count": len(by_shard),
        "shards": sorted(by_shard),
        "pluto_hpd_join_hit_rate": pluto_hit_rate,
    }
    _MANIFEST_PATH.write_text(json.dumps(manifest))
    return manifest


def warm_caches() -> None:
    """Bake every real cell's profile if it hasn't been baked yet. Called
    once by Dockerfile's build-time step and by api.py's startup handler,
    mirroring every other warm_caches() in this codebase. Safe to call more
    than once -- a no-op once the manifest exists.

    Defensively re-warms its own dependencies first (buildings.parquet,
    the POI/station/anchor-time tables, the citywide crime bake) -- each of
    those is itself a no-op once already baked, the same defensive-warm
    pattern profile.py's own `_crime_percentile()` already uses for
    citywide.warm_caches().
    """
    if _MANIFEST_PATH.exists():
        staleness.warn_if_stale(
            _MANIFEST_PATH, config.CELL_PROFILE_CACHE_MAX_AGE_S, "per-cell profiles"
        )
        return
    buildings.warm_cache()
    profile.warm_caches()
    citywide.warm_caches()
    _bake_all()


@lru_cache(maxsize=None)
def _load_shard(shard: str) -> dict[str, dict]:
    path = _shard_path(shard)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} has not been baked yet -- call bearings.cellprofile."
            "warm_caches() first."
        )
    return json.loads(path.read_text())


def manifest() -> dict:
    """The bake's own summary -- cell/shard counts and the PLUTO<->HPD join
    hit rate. Requires warm_caches() to have run first."""
    if not _MANIFEST_PATH.exists():
        raise FileNotFoundError(
            f"{_MANIFEST_PATH} has not been baked yet -- call bearings."
            "cellprofile.warm_caches() first."
        )
    return json.loads(_MANIFEST_PATH.read_text())


def profile_for(h3_id: str) -> dict | None:
    """The precomputed profile for one real H3 res-9 cell -- a pure lookup,
    no live external calls. Returns `None` if `h3_id` is not one of this
    build's real cells (see the module docstring for how "real" is
    decided) -- api.py's GET /api/cell/{h3} turns that into a 404, never a
    fabricated empty-but-present profile.

    Requires warm_caches() to have run first -- raises FileNotFoundError
    otherwise, matching every other not-baked-yet guard in this codebase.
    """
    if not _MANIFEST_PATH.exists():
        raise FileNotFoundError(
            f"{_MANIFEST_PATH} has not been baked yet -- call bearings."
            "cellprofile.warm_caches() first."
        )
    try:
        shard = cellslib.shard_for(h3_id)
    except (ValueError, TypeError):
        # h3-py raises on a string that isn't a real H3 index at all (e.g.
        # a garbage path segment on GET /api/cell/{h3}) -- that is "not a
        # real cell", the same outcome as a syntactically-valid cell this
        # build never baked, not a 500-worthy server error.
        return None
    try:
        shard_map = _load_shard(shard)
    except FileNotFoundError:
        return None
    return shard_map.get(h3_id)
