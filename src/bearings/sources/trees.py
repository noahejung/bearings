"""Street tree census -- living trees near a point.

This dataset carries `latitude`/`longitude` as plain numeric-text fields
but has no Socrata Point/Location column -- confirmed live two ways:
`within_circle(the_geom, ...)` 400s with "no such column: the_geom", and
the dataset's own column metadata lists no point-typed field. So this
always filters with a lat/lng bounding box rather than `within_circle`
(the fallback the plan calls for when a dataset lacks a spatial column).

`status` is one of Alive/Dead/Stump (confirmed live via
`$select=distinct status`); only Alive counts as green cover."""

import math

import pandas as pd

from bearings.sources import socrata

SOURCE = {
    "name": "NYC Street Tree Census",
    "url": "https://data.cityofnewyork.us/d/uvpi-gqnh",
}

_M_PER_DEG_LAT = 111_320.0


def _bbox(lat: float, lng: float, radius_m: float) -> tuple[float, float, float, float]:
    """(min_lat, max_lat, min_lng, max_lng) approximating a circle of
    `radius_m` around (lat, lng). A bbox is always a slight
    over-approximation of the circle at its corners, never an
    under-approximation, so it cannot silently miss a tree the circle
    would have counted."""
    dlat = radius_m / _M_PER_DEG_LAT
    dlng = radius_m / (_M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng


def near(lat: float, lng: float, radius_m: float = 400) -> int:
    """Count of living street trees within `radius_m` metres of a point."""
    min_lat, max_lat, min_lng, max_lng = _bbox(lat, lng, radius_m)
    where = (
        f"status='Alive' "
        f"AND latitude > {min_lat} AND latitude < {max_lat} "
        f"AND longitude > {min_lng} AND longitude < {max_lng}"
    )
    df = socrata.fetch("trees", select="count(*)", where=where)
    if df.empty:
        return 0
    return int(df.iloc[0]["count"])


def points_in_bbox(bbox: dict) -> pd.DataFrame:
    """Every living street tree's raw (lat, lng) inside a `{"south",
    "north", "west", "east"}` box -- for bucketing into H3 cells
    (mapgeo.py's per-cell street-tree-density metric), unlike `near()`
    above which only ever returns a single radius count. Same lat/lng
    bounding-box filter as `near()` (no Socrata Point column on this
    dataset -- see module docstring), just parameterised by an explicit
    box instead of a point+radius.
    """
    where = (
        f"status='Alive' "
        f"AND latitude > {bbox['south']} AND latitude < {bbox['north']} "
        f"AND longitude > {bbox['west']} AND longitude < {bbox['east']}"
    )
    df = socrata.fetch("trees", select="latitude,longitude", where=where, limit=50_000)
    if df.empty:
        return pd.DataFrame({"lat": pd.Series(dtype=float), "lng": pd.Series(dtype=float)})
    return pd.DataFrame(
        {"lat": df["latitude"].astype(float), "lng": df["longitude"].astype(float)}
    )


def citywide_points() -> pd.DataFrame:
    """Every living street tree citywide, as (lat, lng) -- for the per-cell
    precompute bake (bearings.cellprofile), which needs the whole dataset,
    not one bbox-scoped page. Unlike points_in_bbox() (capped at a single
    50k-row Socrata page, correct for a k=3-disk-sized live map request),
    this pages through the full dataset via socrata.fetch()'s own built-in
    pagination -- no limit cap. Confirmed live 2026-07-15: 652,173 living
    trees citywide, a one-time cost of roughly a minute, paid at build
    time, never in a request path."""
    df = socrata.fetch("trees", select="latitude,longitude", where="status='Alive'")
    if df.empty:
        return pd.DataFrame({"lat": pd.Series(dtype=float), "lng": pd.Series(dtype=float)})
    return pd.DataFrame(
        {"lat": df["latitude"].astype(float), "lng": df["longitude"].astype(float)}
    )
