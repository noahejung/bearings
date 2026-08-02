"""Living tree points near a point -- NYC Parks' ForMS 2.0 Forestry Tree
Points, the live successor to the frozen 2015 Street Tree Census this
module used before 2026-08-02.

**Schema is entirely different from the old dataset -- confirmed live, not
assumed from the old module's shape.** The 2015 census had a single
`status` field (Alive/Dead/Stump) and plain lat/lng text columns with no
Socrata Point column at all. This dataset has neither: "is this tree still
standing" is `tpstructure` (Full/Retired/Shaft/Stump/Stump - Uprooted --
confirmed live via `$select=distinct tpstructure`), and tree *condition*
(Excellent/Good/Fair/Poor/Critical/Dead/Unknown) is the separate
`tpcondition` field. A tree can be `tpstructure='Full'` (still occupying
its planting space, not yet removed) and `tpcondition='Dead'` at the same
time -- 10,441 such rows confirmed live -- so "a living tree standing
today" is `tpstructure='Full' AND tpcondition != 'Dead'`, not `tpstructure
='Full'` alone. This is the new dataset's closest real equivalent to the
old `status='Alive'` filter, not a guess: confirmed live at the Empire
State Building fixture below, the new filter returns 284 trees within
400m against the old dataset's own confirmed-live 283 -- a near-exact
match at a typical dense urban corner.

Also unlike the 2015 census, this dataset carries a real Point-typed
`location` column (confirmed live via a live `within_circle`/`within_box`
probe, both 200), so this module uses Socrata's spatial predicates
directly instead of the lat/lng bounding-box workaround the old module
needed.

**A real, honestly-stated scope caveat, not glossed over:** this dataset's
own description is "Record of Forestry tree points for NYC Parks &
Recreation" -- it is Parks Dept's full tree inventory, not curbside street
trees exclusively the way the old census was scoped. Confirmed live: at a
typical dense street corner (Empire State Building, no park nearby) the
count is nearly identical to the old street-only census (284 vs 283), but
in a bounding box that happens to include park frontage (mapgeo.py's own
ESB_BBOX test fixture, which reaches into Bryant Park) the new count is
2,171 against the old dataset's 830 -- roughly 2.6x higher, because park-
interior trees are now counted too. This module does not attempt to
separate "curbside" from "park interior" (this dataset carries no such
flag); the field name below remains `street_trees_nearby` for API-contract
stability, but the caveat is real and worth remembering when reading a
count near a park.

Citywide count of what this module counts as "living" (tpstructure='Full'
AND tpcondition != 'Dead'): 888,653, confirmed live 2026-08-02 -- up from
the old census's 652,173 living street trees, consistent with the broader
scope above, not solely tree growth over a decade.

Updates roughly every 2 weeks (confirmed live via the dataset's own
Socrata metadata `rowsUpdatedAt`), against the old census's single 2015
snapshot."""

import pandas as pd

from bearings.sources import socrata

SOURCE = {
    "name": "NYC Forestry Tree Points (ForMS 2.0)",
    "url": "https://data.cityofnewyork.us/d/hn5i-inap",
}

_LIVING = "tpstructure='Full' AND tpcondition!='Dead'"


def near(lat: float, lng: float, radius_m: float = 400) -> int:
    """Count of living tree points within `radius_m` metres of a point."""
    where = f"{_LIVING} AND within_circle(location, {lat}, {lng}, {radius_m})"
    df = socrata.fetch("trees", select="count(*)", where=where)
    if df.empty:
        return 0
    return int(df.iloc[0]["count"])


def points_in_bbox(bbox: dict) -> pd.DataFrame:
    """Every living tree point's raw (lat, lng) inside a `{"south",
    "north", "west", "east"}` box -- for bucketing into H3 cells
    (mapgeo.py's per-cell tree-density metric), unlike `near()` above which
    only ever returns a single radius count."""
    where = (
        f"{_LIVING} AND within_box(location, "
        f"{bbox['north']}, {bbox['west']}, {bbox['south']}, {bbox['east']})"
    )
    df = socrata.fetch("trees", select="location", where=where, limit=50_000)
    if df.empty:
        return pd.DataFrame({"lat": pd.Series(dtype=float), "lng": pd.Series(dtype=float)})
    lats = [pt["coordinates"][1] for pt in df["location"]]
    lngs = [pt["coordinates"][0] for pt in df["location"]]
    return pd.DataFrame({"lat": lats, "lng": lngs})


def citywide_points() -> pd.DataFrame:
    """Every living tree point citywide, as (lat, lng) -- for the per-cell
    precompute bake (bearings.cellprofile), which needs the whole dataset,
    not one bbox-scoped page. Unlike points_in_bbox() (capped at a single
    50k-row Socrata page), this pages through the full dataset via
    socrata.fetch()'s own built-in pagination -- no limit cap. Confirmed
    live 2026-08-02: 888,653 living tree points citywide (see module
    docstring for how that compares to the old 2015 census's 652,173)."""
    df = socrata.fetch("trees", select="location", where=_LIVING)
    if df.empty:
        return pd.DataFrame({"lat": pd.Series(dtype=float), "lng": pd.Series(dtype=float)})
    lats = [pt["coordinates"][1] for pt in df["location"]]
    lngs = [pt["coordinates"][0] for pt in df["location"]]
    return pd.DataFrame({"lat": lats, "lng": lngs})
