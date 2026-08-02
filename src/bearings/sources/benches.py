"""DOT Seating Locations -- benches and leaning bars near a point.

Net-new source, not previously wired into this codebase (the older, frozen
"City Bench Locations" dataset, whjh-s3x7, last touched 2020-12-22, was
never used here either). This dataset ("Seating Locations", esmy-s8q5) was
last touched 2026-07-10, confirmed live via its own Socrata metadata.

Schema confirmed live via a `$limit=5` probe: a real Point-typed `the_geom`
(used below for `within_circle`), plus plain `latitude`/`longitude` text
columns (unused here -- `the_geom` is the queryable spatial column). Every
row also carries `asset_subtype`, confirmed live via `$select=distinct
asset_subtype` to be one of: `BACKED 1.0`, `BACKED 2.0`, `BACKLESS 1.0`,
`BACKLESS 2.0`, `LEANING BAR`, `UNKNOWN BENCH`, `WORLDS FAIR`. A leaning
bar is a lean-against surface, not a seat -- a materially different
amenity, so this module reports it as its own count rather than folding it
into "benches nearby" (the same discipline this codebase already applies
to e.g. heat.py's `joined_on` and bedbugs.py's infested/reinfested split:
never silently conflate two different facts into one number). The
`category` column this dataset also carries is entirely empty on every row
(confirmed live via `$select=distinct category` returning only `[{}]`) and
is not used.

3,562 rows citywide, confirmed live 2026-08-02 -- 338 of them (~9.5%)
LEANING BAR. A count of 0 nearby is a real "looked, found none" (this is a
complete physical inventory, not a voluntary-complaint dataset), never
conflated with "no record" -- there is no "no record" case for this
module; every query returns a real count, possibly zero."""

import pandas as pd

from bearings.sources import socrata

SOURCE = {
    "name": "NYC DOT Seating Locations",
    "url": "https://data.cityofnewyork.us/d/esmy-s8q5",
}

_LEANING_BAR = "LEANING BAR"


def near(lat: float, lng: float, radius_m: float = 400) -> dict:
    """Real bench/leaning-bar counts within `radius_m` metres of a point.
    `benches` is every seat-type row (BACKED/BACKLESS/UNKNOWN
    BENCH/WORLDS FAIR); `leaning_bars` is reported separately since you
    cannot sit on one -- see module docstring."""
    where = f"within_circle(the_geom, {lat}, {lng}, {radius_m})"
    df = socrata.fetch("benches", select="asset_subtype", where=where)
    if df.empty:
        return {"benches": 0, "leaning_bars": 0, "source": dict(SOURCE)}
    is_bar = df["asset_subtype"] == _LEANING_BAR
    return {
        "benches": int((~is_bar).sum()),
        "leaning_bars": int(is_bar.sum()),
        "source": dict(SOURCE),
    }


def points_in_bbox(bbox: dict) -> pd.DataFrame:
    """Every seating point's raw (lat, lng) inside a `{"south", "north",
    "west", "east"}` box, plus its `asset_subtype` -- for bucketing into H3
    cells the same way sources/trees.py's points_in_bbox() does."""
    where = (
        f"within_box(the_geom, "
        f"{bbox['north']}, {bbox['west']}, {bbox['south']}, {bbox['east']})"
    )
    df = socrata.fetch(
        "benches", select="the_geom,asset_subtype", where=where, limit=50_000
    )
    if df.empty:
        return pd.DataFrame(
            {
                "lat": pd.Series(dtype=float),
                "lng": pd.Series(dtype=float),
                "asset_subtype": pd.Series(dtype=str),
            }
        )
    lats = [pt["coordinates"][1] for pt in df["the_geom"]]
    lngs = [pt["coordinates"][0] for pt in df["the_geom"]]
    return pd.DataFrame({"lat": lats, "lng": lngs, "asset_subtype": df["asset_subtype"]})


def citywide_points() -> pd.DataFrame:
    """Every seating point citywide, as (lat, lng, asset_subtype) -- for
    the per-cell precompute bake (bearings.cellprofile). No pagination cap
    needed in practice (3,562 rows citywide, well under one 50k-row
    Socrata page), but this still goes through socrata.fetch()'s own
    pagination rather than a hardcoded single request, matching every
    other citywide_points() in this codebase."""
    df = socrata.fetch("benches", select="the_geom,asset_subtype")
    if df.empty:
        return pd.DataFrame(
            {
                "lat": pd.Series(dtype=float),
                "lng": pd.Series(dtype=float),
                "asset_subtype": pd.Series(dtype=str),
            }
        )
    lats = [pt["coordinates"][1] for pt in df["the_geom"]]
    lngs = [pt["coordinates"][0] for pt in df["the_geom"]]
    return pd.DataFrame({"lat": lats, "lng": lngs, "asset_subtype": df["asset_subtype"]})
