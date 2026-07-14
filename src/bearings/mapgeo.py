"""Real map geometry for one address -- the data behind VISUAL.md's hybrid
base map: real GTFS subway/PATH alignments, real GTFS stations, and real
per-H3-cell 311 noise density for the neighbourhood around an address.

What this module deliberately does NOT produce: street centrelines or
building-mass footprints. VISUAL.md's map spec assumed Overture's
`transportation` and `buildings` themes were "already ingested" the same
way `places` is (see overture.py's fetch_pois()) -- they are not, and a
live per-request bbox query against either is not viable at this
codebase's data scale. Confirmed live 2026-07-14 by listing the actual S3
prefixes (`?list-type=2&prefix=release/<rel>/theme=<theme>/type=<type>/`):

    theme=places/type=place              16 files,  ~11 GB total
    theme=transportation/type=segment   128 files,  ~60 GB total
    theme=buildings/type=building       512 files, ~276 GB total

`places` is the one theme this codebase already ingests (fetch_pois(),
~48.9s for the whole NYC bbox during the Docker build -- see the deploy
dispatch's own measurement). A same-shaped bbox query against
`transportation`, scoped to a single ~700m-radius neighbourhood (a much
*smaller* area than the whole-NYC places query that already works), was
run live against this same DuckDB+httpfs setup and did not return within
3 minutes, climbing past 766MB resident memory before being killed.
Unlike `places`, neither `transportation` nor `buildings` appears to be
laid out in a way that lets DuckDB's Parquet row-group statistics skip
most of each multi-hundred-megabyte file for an unrelated bbox -- so the
query has to touch most of a many-gigabyte file per request. That is a
genuine offline batch-ingestion project (mirroring how `warm_caches()`
already bakes the POI table and transit graph at build time, not request
time), not something this dispatch's time budget covers. Shipping it
"anyway" would mean either a multi-minute page load or silently drawing
nothing -- both worse than the honest gap `basemap_note` states below.

What IS real here: GTFS shapes.txt (local, already-cached zips, cheap for
any address) and 311 noise complaints, queried once per request as a
single bounding-box Socrata call (not one call per cell) and bucketed into
real H3 cells with the same `h3` library the rest of the pipeline uses.
"""

import math
from datetime import datetime, timedelta, timezone

import h3
import pandas as pd

from bearings import cells, config, transit
from bearings.sources import gtfs, socrata

# Matches the approved prototype's k=3 disk (37 cells) and its ~700m
# half-width box -- see the dispatch's scratchpad bearings-map.html /
# fetch_geo.py.
MAP_DISK_K = 3
BBOX_RADIUS_M = 700.0
_NOISE_WINDOW_DAYS = 365

BASEMAP_NOTE = (
    "Street and building base layers are not rendered. Overture's "
    "transportation (~60GB across 128 files) and buildings (~276GB across "
    "512 files) themes have no viable per-request bounding-box query at "
    "this codebase's current ingestion pattern -- confirmed live "
    "2026-07-14, see mapgeo.py's module docstring. Subway alignments "
    "(GTFS shapes.txt) and H3 cell density (real NYC 311 counts) below "
    "are real; streets and building mass are an honest gap, not a "
    "guessed drawing."
)

SOURCES = {
    "subway": dict(transit.SOURCE),
    "cells": {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"},
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
    approach of letting the SVG frame do the clipping."""
    lines: list[dict] = []
    for feed in gtfs.FEEDS:
        for row in gtfs.shapes(feed).itertuples():
            if _shape_touches_bbox(row.coords, bbox):
                lines.append({"coords": [[lat, lng] for lat, lng in row.coords]})
    return lines


def _stations_in_bbox(bbox: dict) -> list[dict]:
    all_stations = pd.concat(
        [gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True
    )
    hit = all_stations[
        all_stations["lat"].between(bbox["south"], bbox["north"])
        & all_stations["lng"].between(bbox["west"], bbox["east"])
    ]
    return [{"name": r.name, "lat": r.lat, "lng": r.lng} for r in hit.itertuples()]


def _cell_values(subject_cell: str, bbox: dict) -> list[dict]:
    """Real 311 noise-complaint counts, one per H3 cell in the k=3 disk
    around the subject cell -- a single bounding-box query over the whole
    visible area, then bucketed by cell in Python, rather than 37 separate
    per-cell radius queries. Every cell in the disk gets a real int (a
    true zero when the query found nothing there), never a missing key --
    the disk is enumerated first and only then filled in from the query
    results, so an unqueried cell is structurally impossible.
    """
    ring = cells.neighbors(subject_cell, k=MAP_DISK_K)
    counts: dict[str, int] = {c: 0 for c in ring}

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

    for row in df.itertuples():
        try:
            plat, plng = float(row.latitude), float(row.longitude)
        except (TypeError, ValueError):
            continue
        cell = h3.latlng_to_cell(plat, plng, config.H3_RES)
        if cell in counts:
            counts[cell] += 1

    return [{"h3": c, "value": v} for c, v in counts.items()]


def map_geometry(lat: float, lng: float, bbl: str | None) -> dict:
    """Everything the map component needs for the neighbourhood around one
    point: real subway/PATH lines, real stations, and real per-cell noise
    density for the k=3 H3 disk -- see the module docstring for what is
    deliberately NOT included (streets, buildings) and why.
    """
    subject_cell = cells.cell_for(lat, lng)
    bbox = _bbox_for(lat, lng, radius_m=BBOX_RADIUS_M)

    return {
        "subject": {"lat": lat, "lng": lng, "bbl": bbl, "cell": subject_cell},
        "bbox": bbox,
        "subway_lines": _subway_lines(bbox),
        "stations": _stations_in_bbox(bbox),
        "cells": _cell_values(subject_cell, bbox),
        "basemap_note": BASEMAP_NOTE,
        "sources": SOURCES,
    }
