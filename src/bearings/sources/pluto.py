"""Building age from PLUTO (Primary Land Use Tax Lot Output).

PLUTO's `bbl` column stores the borough-block-lot as a decimal-suffixed
numeric string ("1008350041.00000000" -- confirmed live), but Socrata
coerces a plain BBL string like "1008350041" to the same value for `=`
comparison, so no reformatting is needed on our side (confirmed live: the
Empire State Building's own BBL round-trips this way).

`yearbuilt` of "0" is PLUTO's documented sentinel for "not recorded" --
confirmed live against a real Bronx lot. It must map to `None`, never be
surfaced as a year: the spec's non-negotiable rule is that missing data is
`null`, never a guess, and 0 AD is not a plausible construction year for
anything in this dataset."""

import pandas as pd

from bearings.sources import socrata

SOURCE = {"name": "NYC PLUTO", "url": "https://data.cityofnewyork.us/d/64uk-42ks"}

_PREWAR_BEFORE = 1940
_POSTWAR_BEFORE = 2000


def _era(year: int) -> str:
    if year < _PREWAR_BEFORE:
        return "prewar"
    if year < _POSTWAR_BEFORE:
        return "postwar"
    return "modern"


def building(bbl: str) -> dict:
    """`{"year_built": int | None, "era": str | None}` for the lot at `bbl`."""
    df = socrata.fetch("pluto", select="yearbuilt", where=f"bbl='{bbl}'")

    if df.empty:
        return {"year_built": None, "era": None}

    year = int(float(df.iloc[0]["yearbuilt"]))
    if year == 0:
        return {"year_built": None, "era": None}

    return {"year_built": year, "era": _era(year)}


def points_in_bbox(bbox: dict) -> pd.DataFrame:
    """Every PLUTO lot's raw (lat, lng, year_built) inside a `{"south",
    "north", "west", "east"}` box -- for bucketing into H3 cells
    (mapgeo.py's per-cell building-age metric: a real median year-built,
    not a single lot's year).

    `latitude`/`longitude` are real Number-typed PLUTO columns (confirmed
    live -- SoQL numeric comparisons against them work directly, even
    though the Socrata JSON response serialises every field as a string).
    `yearbuilt=0` is excluded here for the same reason `building()` above
    maps it to `None`: PLUTO's own documented sentinel for "not recorded",
    never a real construction year.
    """
    where = (
        f"latitude > {bbox['south']} AND latitude < {bbox['north']} "
        f"AND longitude > {bbox['west']} AND longitude < {bbox['east']} "
        f"AND yearbuilt > 0"
    )
    df = socrata.fetch(
        "pluto", select="latitude,longitude,yearbuilt", where=where, limit=50_000
    )
    if df.empty:
        return pd.DataFrame(
            {
                "lat": pd.Series(dtype=float),
                "lng": pd.Series(dtype=float),
                "year_built": pd.Series(dtype=int),
            }
        )
    return pd.DataFrame(
        {
            "lat": df["latitude"].astype(float),
            "lng": df["longitude"].astype(float),
            "year_built": df["yearbuilt"].astype(float).astype(int),
        }
    )
