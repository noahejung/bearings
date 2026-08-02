"""DOT Street Pavement Ratings -- street-surface quality near a point.

Net-new source, not previously wired into this codebase. Confirmed live
2026-08-02: 514,521 rows, updated monthly (most recent inspection pass in
this dataset at probe time: 2026-08-01), scale 1-10 per the dataset's own
published description (Good 8.00-10, Fair 4.00-7.00, Poor 1.00-3.00 -- with
an unimplemented exception noted below).

**Two schema facts that would silently produce a wrong number if missed,
confirmed live, not assumed:**

1. **`systemrating=0.0` does NOT mean "rated zero" -- it means "not rated
   this pass."** Confirmed live: of 72,768 rows with `systemrating=0`,
   72,766 also carry a real `nonratingreason` (Construction, Duplicate,
   Multi-pass, Weather, Road Identification, Intersection, Gated, Private,
   Expressway, Pedestrian Walkway, Step Street, Special Event, Traffic,
   "Does Not Exist," "Not a Multi-pass," "Rating Not Applicable," Other) --
   this is exactly the None-vs-0 conflation this project's own invariants
   warn about, and it would have silently dragged every average toward a
   catastrophic "0/10" if not filtered out. This module only ever counts a
   row as a real rating when `nonratingreason IS NULL`.
2. **The geometry column (`the_geom`) is a MultiLineString (a street
   segment), not a Point.** Confirmed live via a live schema probe. This
   dataset carries no lat/lng point columns at all. `within_circle` still
   works against a line geometry (confirmed live: it returns segments that
   intersect the circle, not just point-in-circle) -- this module relies on
   that, not on any point-column workaround.

**Multiple rows per segment, one per inspection pass -- confirmed live**
(a single `oftcode` near the Empire State Building carries 6 historical
inspection rows going back to 2019). This module fetches every row within
radius, then keeps only the most recent real (non-`nonratingreason`)
rating per segment, client-side in pandas -- same "fetch everything, sort,
keep latest" shape as bedbugs.py's per-BBL "most recent filing" logic, for
the same reason: the shared Socrata client has no server-side "top 1 per
group" support and a per-segment inspection-row count is small enough
(single digits) that this is cheap.

**The dataset's own published bucket rule has a stated exception this
module does NOT implement, on purpose, stated rather than silently
mis-applied:** "Fair (%) - ratings of 4.00 to 7.00 (except on local streets
where a 7 is good)." `road_type` (confirmed live via `$select=distinct
road_type`) is one of `Main`, `OverPass`, `Service`, `UnderPass`, or null
-- there is no `road_type='Local'` value in this dataset at all, so the
exact mechanism DOT's own description refers to could not be confirmed or
implemented from this dataset's own columns. Rather than guess at a rule
this dataset does not expose, this module applies the plain Good/Fair/Poor
thresholds from the description (8-10 / 4-7 / 1-3, with 7-8 uncategorized
in the source description and bucketed here as Fair) uniformly, and
reports the raw average rating alongside the bucket counts so a caller
never has to trust the bucket alone.

**Deliberately NOT precomputed into the citywide per-cell bake
(cellprofile.py), unlike trees/benches.** Baking this citywide would need
a true point-to-segment nearest-line calculation for ~7,000 H3 cells (a
cell's centroid isn't necessarily near any line segment's *endpoint*, so a
naive centroid-to-vertex distance would silently pick the wrong nearest
street for a cell that sits mid-segment) -- exactly the "plausible but
silently wrong" number shape this project's own `AnchorSnapTooFar` guard
exists to prevent (see bearings' project memory on the 2.3km subway-anchor
snap bug). This codebase has no spatial library (`shapely`/`geopandas`) in
its dependencies to do that calculation correctly, and adding one plus
verifying the join is real, unbounded, non-trivial work -- not attempted
this pass, flagged explicitly here (matching flood.py's own "not baked,
here's why" precedent) rather than shipped as a silently-approximate
per-cell number."""

import pandas as pd

from bearings.sources import socrata

SOURCE = {
    "name": "NYC DOT Street Pavement Ratings",
    "url": "https://data.cityofnewyork.us/d/6yyb-pb25",
}

_GOOD_AT_OR_ABOVE = 8.0
_POOR_BELOW = 4.0


def near(lat: float, lng: float, radius_m: float = 250) -> dict | None:
    """Street pavement condition on segments within `radius_m` metres of a
    point, based on each segment's own most recent real inspection.
    Returns `None` if no segment near this point has ever carried a real
    rating (a genuine "no record" case -- e.g. a private or gated street,
    or simply no DOT-rated pavement in range) -- never a fabricated 0."""
    where = f"within_circle(the_geom, {lat}, {lng}, {radius_m})"
    df = socrata.fetch(
        "pavement",
        select="oftcode,systemrating,nonratingreason,inspection",
        where=where,
    )
    if df.empty:
        return None

    df["inspection"] = pd.to_datetime(df["inspection"])
    df = df.sort_values("inspection", ascending=False)
    latest = df.groupby("oftcode", as_index=False).first()
    rated = latest[latest["nonratingreason"].isna()]
    if rated.empty:
        return None

    ratings = rated["systemrating"].astype(float)
    good = int((ratings >= _GOOD_AT_OR_ABOVE).sum())
    poor = int((ratings < _POOR_BELOW).sum())
    fair = int(len(ratings)) - good - poor

    return {
        "segments_rated": int(len(rated)),
        "average_rating": round(float(ratings.mean()), 2),
        "good": good,
        "fair": fair,
        "poor": poor,
        "most_recent_inspection": str(rated["inspection"].max().date()),
        "source": dict(SOURCE),
    }
