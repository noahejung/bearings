"""Real map geometry for one address -- the data behind VISUAL.md's hybrid
base map: real building-footprint mass, real street centrelines, real GTFS
subway/PATH alignments and stations, and real per-H3-cell 311 noise density
for the neighbourhood around an address.

Streets and building mass were originally a stated gap here: VISUAL.md's
map spec assumed Overture's `transportation` and `buildings` themes were
"already ingested" the same way `places` is (see overture.py's
fetch_pois()), but a live probe (2026-07-14) found `transportation` is
~60GB across 128 files and `buildings` ~276GB across 512 files -- a
per-request bbox query against either does not return within 3 minutes.
That finding stands; Overture remains the wrong source for these two
layers at this codebase's data scale.

What changed: NYC Open Data's *own* building-footprint and street-centreline
datasets are a different animal from Overture's global slices -- they are
NYC-scoped from the source, not a slice of a planet-sized file, so they are
small enough (1.08M footprints, 122k centreline segments -- confirmed live
2026-07-14) to bake in full at build time the same way `warm_caches()`
already bakes the POI table and transit graph. See sources/buildings.py and
sources/streets.py for the fetch/bake/bbox-slice pipeline; this module only
does the fast request-time bbox slice against their already-baked Parquet
files (`footprints_in_bbox()` / `segments_in_bbox()`), never touching
Socrata directly for these two layers.

GTFS shapes.txt (local, already-cached zips, cheap for any address) and 311
noise complaints (a single bounding-box Socrata call, not one call per
cell) round out the picture, bucketed into real H3 cells with the same
`h3` library the rest of the pipeline uses.

**Per-cell metric dropdown (VISUAL.md §5, REVISED 2026-07-15).** Every cell
in the k=3 disk now carries five real metrics, not just noise -- the
heat-map toggle became a metric dropdown, and each metric it offers must be
an honestly-computed value for the area it shades, never a fabricated
citywide surface (see this module's own per-metric functions below for
what each one measures and where its number comes from):

  - `noise`: real 311 noise-complaint counts (unchanged from before).
  - `amenities`: real Overture POI counts (the same eight daily-life
    categories `api.py`'s report card already uses -- grocery, cafe, bar,
    restaurant, pharmacy, gym, park, laundry), read straight from the
    already-baked `data/derived/pois.parquet` (a local groupby, no new
    live fetch -- `cell` is already a column on that Parquet file).
  - `trees`: real living-street-tree counts (`sources/trees.py`'s
    `points_in_bbox()`, bucketed by cell the same way noise is).
  - `building_age_years`: the real median PLUTO `yearbuilt` of every lot
    in a cell, or `None` if no PLUTO lot with a recorded year falls in
    that cell -- never a fabricated single-lot answer standing in for a
    whole cell, and never a guessed year where PLUTO's own `yearbuilt=0`
    sentinel (not recorded) is all that's on record.
  - `transit_access`: a labelled PROXY, not a claim about commute time --
    the count of real subway/PATH stations within `TRANSIT_ACCESS_RADIUS_M`
    of the cell's own centroid. There is no citywide "time to destination"
    value (a commute is always time *to somewhere*), so this offers the one
    citywide-honest substitute: how much real transit infrastructure sits
    within a normal walk of this specific cell.

None of these five are a build-time bake (unlike the crime/precinct
choropleth in citywide.py) -- every one is computed live, per request,
scoped to the k=3 disk around whichever address was searched, the same way
noise already was. This keeps Docker build time and image size completely
unaffected (the dispatch's own stated concern for building age/flood) at
the cost of a few real seconds of per-request Socrata/Parquet work, already
the existing tradeoff for noise.

**Flood zone and the sparse per-building datasets (heat, rodents, bedbugs)
are deliberately NOT here.** FEMA's NFHL is a single-point-at-a-time
ArcGIS service with no bounding-box query capability and a live-confirmed
~30-50% transient-failure rate (see `sources/flood.py`'s own docstring) --
querying it once per cell (up to 37 real external calls per map load, each
with its own retry-with-backoff) is neither fast enough for a live request
nor reliable enough to bake citywide without the failure rate ballooning
build time unpredictably. Heat/rodent/bedbug complaint data is per-building
and voluntarily filed -- a quiet cell there could mean "no problem" or
could mean "nobody filed a complaint here," which is exactly the kind of
surface this project's own rule against fabricated citywide data forbids
shading a map with. The frontend dropdown shows all of these, greyed out,
with their real reason stated plainly -- never silently omitted.
"""

import math
import statistics
from datetime import datetime, timedelta, timezone

import duckdb
import h3
import pandas as pd

from bearings import cells, config, transit
from bearings.sources import basemap, buildings, gtfs, overture, pluto, socrata, streets
from bearings.sources import trees as trees_source
from bearings.transit import _haversine_m

# Matches the approved prototype's k=3 disk (37 cells) and its ~700m
# half-width box -- see the dispatch's scratchpad bearings-map.html /
# fetch_geo.py.
MAP_DISK_K = 3
BBOX_RADIUS_M = 700.0
_NOISE_WINDOW_DAYS = 365

# The same eight daily-life categories api.py's report card already sums
# (overture.CATEGORY_MAP's own value set -- never the ~93%-of-NYC "other"
# bucket that map never had a real bucket of its own).
AMENITY_CATEGORIES = sorted(set(overture.CATEGORY_MAP.values()))

# "Convenient walk" radius for the transit-access proxy metric -- roughly
# 6 minutes at transit.WALK_SPEED_MPS, deliberately smaller than profile.py's
# STATION_SEARCH_M=1200 (that one finds "the nearest 3 stations from a
# single point, however far"; this one asks "how much real transit sits
# within an easy walk of this specific cell").
TRANSIT_ACCESS_RADIUS_M = 500.0

_POIS_PATH = config.DERIVED_DIR / "pois.parquet"

BASEMAP_NOTE = (
    "The base map is a self-hosted PMTiles extract of the Protomaps daily "
    "OpenStreetMap build (styled to this report's own palette, served from "
    "this app's own origin -- no third-party tile server at request time; "
    "see sources/basemap.py). Every layer drawn on top of it is real, "
    "computed from public records: building footprints and street "
    "centrelines (NYC Open Data, baked once at build time -- see "
    "sources/buildings.py and sources/streets.py), subway/PATH alignments "
    "and route labels (GTFS shapes.txt), and five real per-cell metrics -- "
    "311 noise, Overture daily-life amenity counts, living street trees, "
    "median PLUTO building age, and nearby-transit-station counts. Every "
    "line on this sheet was computed from a dataset this report also cites."
)

SOURCES = {
    "basemap": dict(basemap.SOURCE),
    "subway": dict(transit.SOURCE),
    "cells": {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"},
    "buildings": dict(buildings.SOURCE),
    "streets": dict(streets.SOURCE),
    "amenities": dict(overture.SOURCE),
    "trees": dict(trees_source.SOURCE),
    "building_age": dict(pluto.SOURCE),
    "transit_access": dict(transit.SOURCE),
}


def _bbox_for(lat: float, lng: float, radius_m: float) -> dict:
    """A lat/lng bounding box of half-width `radius_m`, longitude-corrected
    for latitude (a degree of longitude shrinks toward the poles)."""
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    return {
        "south": lat - dlat,
        "north": lat + dlat,
        "west": lng - dlng,
        "east": lng + dlng,
    }


def _shape_touches_bbox(coords: list[tuple[float, float]], bbox: dict) -> bool:
    return any(
        bbox["south"] <= lat <= bbox["north"] and bbox["west"] <= lng <= bbox["east"]
        for lat, lng in coords
    )


def _subway_lines(bbox: dict) -> list[dict]:
    """Every real GTFS shape (subway + PATH) that passes through the bbox,
    drawn in full -- not clipped to the box, matching the prototype's own
    approach of letting the map frame do the clipping. Each line carries a
    real `route` label (e.g. "B/D/F/M", "PATH") via gtfs.shape_routes() --
    VISUAL.md's map wants subway lines "labelled by route", not just drawn."""
    lines: list[dict] = []
    for feed in gtfs.FEEDS:
        routes = gtfs.shape_routes(feed)
        for row in gtfs.shapes(feed).itertuples():
            if _shape_touches_bbox(row.coords, bbox):
                lines.append(
                    {
                        "coords": [[lat, lng] for lat, lng in row.coords],
                        "route": routes.get(row.shape_id, ""),
                    }
                )
    return lines


def _stations_in_bbox(bbox: dict) -> list[dict]:
    all_stations = pd.concat(
        [gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True
    )
    hit = all_stations[
        all_stations["lat"].between(bbox["south"], bbox["north"])
        & all_stations["lng"].between(bbox["west"], bbox["east"])
    ]
    return [
        {"name": r.name, "lat": r.lat, "lng": r.lng, "routes": r.routes}
        for r in hit.itertuples()
    ]


def _bucket_points_by_cell(
    ring: list[str], points: list[tuple[float, float]]
) -> dict[str, list[tuple[float, float]]]:
    """Every point placed into its H3 res-9 cell, restricted to cells in
    `ring` -- the disk is enumerated first (so every ring cell starts with
    an empty, real list) and only then filled in, the same "structurally
    impossible to miss a cell" shape the original noise-only bucketer used.
    """
    by_cell: dict[str, list[tuple[float, float]]] = {c: [] for c in ring}
    for lat, lng in points:
        cell = h3.latlng_to_cell(lat, lng, config.H3_RES)
        if cell in by_cell:
            by_cell[cell].append((lat, lng))
    return by_cell


def _noise_cell_counts(ring: list[str], bbox: dict) -> dict[str, int]:
    """Real 311 noise-complaint counts, one per H3 cell in `ring` -- a
    single bounding-box query over the whole visible area, then bucketed by
    cell in Python, rather than one query per cell."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_NOISE_WINDOW_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    where = (
        "complaint_type like 'Noise%' "
        f"AND created_date > '{cutoff}' "
        f"AND within_box(location, {bbox['north']}, {bbox['west']}, "
        f"{bbox['south']}, {bbox['east']})"
    )
    df = socrata.fetch("311", select="latitude,longitude", where=where, limit=50_000)
    points: list[tuple[float, float]] = []
    for row in df.itertuples():
        try:
            points.append((float(row.latitude), float(row.longitude)))
        except (TypeError, ValueError):
            continue
    by_cell = _bucket_points_by_cell(ring, points)
    return {c: len(pts) for c, pts in by_cell.items()}


def _amenity_cell_counts(ring: list[str]) -> dict[str, int]:
    """Real Overture daily-life-category POI counts per H3 cell, read
    straight from the already-baked data/derived/pois.parquet -- `cell` is
    already a column on that Parquet file (overture.fetch_pois() computes
    it via cells.cell_for() at bake time), so this is a local groupby, not
    a live fetch or a spatial join. Requires profile.warm_caches() to have
    baked the Parquet file first (api.py's lifespan startup runs it before
    mapgeo.warm_caches() -- see this module's docstring); raises a loud
    FileNotFoundError otherwise, matching buildings.py/streets.py's own
    not-baked-yet guard rather than silently returning all zeros."""
    if not _POIS_PATH.exists():
        raise FileNotFoundError(
            f"{_POIS_PATH} has not been baked yet -- call bearings.profile."
            "warm_caches() first (api.py's startup handler does this before "
            "mapgeo.warm_caches() runs)."
        )
    con = duckdb.connect()
    try:
        placeholders = ",".join("?" for _ in ring)
        cat_placeholders = ",".join("?" for _ in AMENITY_CATEGORIES)
        rows = con.execute(
            f"""
            SELECT cell, count(*) AS n
            FROM read_parquet('{_POIS_PATH.as_posix()}')
            WHERE cell IN ({placeholders}) AND category IN ({cat_placeholders})
            GROUP BY cell
            """,
            [*ring, *AMENITY_CATEGORIES],
        ).fetchall()
    finally:
        con.close()
    counts = {c: 0 for c in ring}
    for cell, n in rows:
        counts[cell] = int(n)
    return counts


def _tree_cell_counts(ring: list[str], bbox: dict) -> dict[str, int]:
    """Real living-street-tree counts per H3 cell -- one bbox query over
    the whole visible area (sources/trees.py's points_in_bbox()), bucketed
    the same way noise is."""
    pts = trees_source.points_in_bbox(bbox)
    points = list(zip(pts["lat"], pts["lng"], strict=True))
    by_cell = _bucket_points_by_cell(ring, points)
    return {c: len(v) for c, v in by_cell.items()}


def _building_age_by_cell(ring: list[str], bbox: dict) -> dict[str, float | None]:
    """The real median PLUTO `yearbuilt` of every lot in a cell, or `None`
    if no lot with a recorded year falls in that cell -- a cell median, not
    a single lot's year standing in for the whole cell, and never a guessed
    year where PLUTO's own yearbuilt=0 sentinel is all that's on record
    (sources/pluto.py's points_in_bbox() already excludes it).

    Deliberately does NOT reuse `_bucket_points_by_cell()` (which buckets
    bare (lat, lng) tuples): two distinct PLUTO lots can share the exact
    same rounded coordinate, and a (lat, lng) -> year lookup dict would
    silently collapse them to whichever year happened to be inserted last.
    Keeping (lat, lng, year_built) together end to end avoids that.
    """
    pts = pluto.points_in_bbox(bbox)
    years_by_cell: dict[str, list[int]] = {c: [] for c in ring}
    for lat, lng, year in zip(pts["lat"], pts["lng"], pts["year_built"], strict=True):
        cell = h3.latlng_to_cell(lat, lng, config.H3_RES)
        if cell in years_by_cell:
            years_by_cell[cell].append(int(year))
    return {
        c: (float(statistics.median(years)) if years else None)
        for c, years in years_by_cell.items()
    }


def _transit_access_by_cell(ring: list[str], stations: list[dict]) -> dict[str, int]:
    """A labelled PROXY for transit access, not a commute-time claim: the
    count of real subway/PATH stations within TRANSIT_ACCESS_RADIUS_M of
    each cell's own centroid -- reuses the station list already fetched for
    this bbox, no new query."""
    out: dict[str, int] = {}
    for c in ring:
        lat, lng = cells.centroid(c)
        out[c] = sum(
            1
            for s in stations
            if _haversine_m((lat, lng), (s["lat"], s["lng"])) <= TRANSIT_ACCESS_RADIUS_M
        )
    return out


def _cell_metrics(subject_cell: str, bbox: dict, stations: list[dict]) -> list[dict]:
    """Five real per-cell metrics for the k=3 disk around the subject cell
    -- see the module docstring for what each one measures, where its
    number comes from, and why flood/heat/rodents/bedbugs are NOT here.
    Every cell in the disk gets a real value for every metric (an int, or
    `None` for building_age_years when genuinely no record exists) -- the
    disk is enumerated first in every helper above, so a missing key is
    structurally impossible.
    """
    ring = cells.neighbors(subject_cell, k=MAP_DISK_K)
    noise = _noise_cell_counts(ring, bbox)
    amenities = _amenity_cell_counts(ring)
    tree_counts = _tree_cell_counts(ring, bbox)
    building_age = _building_age_by_cell(ring, bbox)
    transit_access = _transit_access_by_cell(ring, stations)
    return [
        {
            "h3": c,
            "noise": noise[c],
            "amenities": amenities[c],
            "trees": tree_counts[c],
            "building_age_years": building_age[c],
            "transit_access": transit_access[c],
        }
        for c in ring
    ]


def map_geometry(lat: float, lng: float, bbl: str | None) -> dict:
    """Everything the map component needs for the neighbourhood around one
    point: real subway/PATH lines, real stations, real building/street
    mass, and five real per-cell metrics (noise, amenities, trees,
    building age, transit access) for the k=3 H3 disk -- see the module
    docstring for the full per-metric breakdown and what is deliberately
    NOT included (flood, heat, rodents, bedbugs) and why.
    """
    subject_cell = cells.cell_for(lat, lng)
    bbox = _bbox_for(lat, lng, radius_m=BBOX_RADIUS_M)
    stations = _stations_in_bbox(bbox)

    return {
        "subject": {"lat": lat, "lng": lng, "bbl": bbl, "cell": subject_cell},
        "bbox": bbox,
        "buildings": buildings.footprints_in_bbox(bbox),
        "streets": streets.segments_in_bbox(bbox),
        "subway_lines": _subway_lines(bbox),
        "stations": stations,
        "cells": _cell_metrics(subject_cell, bbox, stations),
        "basemap_note": BASEMAP_NOTE,
        "sources": SOURCES,
    }


def warm_caches() -> None:
    """Bake the building-footprint and street-centreline Parquet files if
    they don't already exist. Called once by Dockerfile's build-time step
    and by api.py's startup handler (mirroring profile.warm_caches()'s own
    pattern) so the first real /api/map request never pays the ~4-minute
    citywide-fetch cost -- see sources/buildings.py and sources/streets.py.
    Safe to call more than once; a no-op once both files exist."""
    buildings.warm_cache()
    streets.warm_cache()
