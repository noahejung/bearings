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


def _clean_bbl(raw: str) -> str | None:
    """PLUTO's own `bbl` column is a decimal-suffixed numeric string
    ("2054800111.00000000", confirmed live) -- collapse it to the same
    10-char zero-padded boro(1)+block(5)+lot(4) shape hpd.py's
    `_bbl_parts()` already expects (the geocoder's own BBL output shape),
    so the two can be joined without either side reformatting.

    Returns `None` for a row whose bbl genuinely doesn't parse (a citywide
    fetch of ~857k rows is bound to contain a handful) -- one bad row must
    not crash the whole citywide_points() call, matching this codebase's
    established one-bad-row-does-not-kill-the-bake pattern (see
    cellprofile.py's `_safe_cell_for()`).
    """
    try:
        return str(int(float(raw))).zfill(10)
    except (TypeError, ValueError):
        return None


def citywide_points() -> pd.DataFrame:
    """Every PLUTO tax lot citywide with a recorded lat/lng, as (bbl, lat,
    lng, year_built) -- for the per-cell precompute bake (bearings.
    cellprofile), which needs the whole ~857k-row dataset, not one
    bbox-scoped page. Unlike points_in_bbox(), `year_built` is NOT filtered
    to >0 here: the caller needs a real `bbl` for every lot (including ones
    with PLUTO's own "not recorded" yearbuilt=0 sentinel) to join HPD
    violations by lot -- filter yearbuilt>0 downstream, only for the
    building-age metric specifically (the same sentinel-exclusion
    points_in_bbox() already does). Confirmed live 2026-07-15: 857,103 lots
    carry a non-null latitude."""
    df = socrata.fetch(
        "pluto",
        select="bbl,latitude,longitude,yearbuilt",
        where="latitude IS NOT NULL AND bbl IS NOT NULL",
    )
    if df.empty:
        return pd.DataFrame(
            {
                "bbl": pd.Series(dtype=str),
                "lat": pd.Series(dtype=float),
                "lng": pd.Series(dtype=float),
                "year_built": pd.Series(dtype=int),
            }
        )
    # A lot can carry a real lat/lng with NO yearbuilt value at all (a
    # genuine NaN, not the documented "0" sentinel) -- confirmed live
    # 2026-07-15. Folded into the same 0-means-"not recorded" convention
    # this module already uses (never left as NaN, which a bare
    # .astype(int) rejects outright).
    year_built = df["yearbuilt"].astype(float).fillna(0).astype(int)
    out = pd.DataFrame(
        {
            "bbl": df["bbl"].map(_clean_bbl),
            "lat": df["latitude"].astype(float),
            "lng": df["longitude"].astype(float),
            "year_built": year_built,
        }
    )
    # Drop the handful of rows whose bbl didn't parse (see _clean_bbl's own
    # docstring) -- these carry a real lat/lng but no usable join key, so
    # they would silently corrupt the HPD-violation join if kept as None.
    return out[out["bbl"].notna()].reset_index(drop=True)
