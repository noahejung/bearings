"""Citywide, address-independent map data -- neighbourhood labels, precinct
boundaries, and per-precinct crime -- for the navigable map's label layer
and crime choropleth (VISUAL.md §5, REVISED 2026-07-15).

This is a different shape from mapgeo.py's map_geometry(): nothing here
depends on which address a user searched. A precinct's boundary and its
CompStat total don't change because a different visitor loaded the map, so
the whole thing is baked once at build time (same build-time-precompute
pattern buildings.py/streets.py already established) and served as a flat,
static blob -- one request from the frontend when the map mounts, not one
per address.

The citywide crime bake is a real expansion of an existing lazy pattern,
worth stating plainly: compstat.py's fetch_precinct() already existed and
was already exercised per-address inside profile.py's safety block (one
precinct, fetched lazily, on the request path). This module calls that same
function for *every* precinct (78, from precincts.all_precinct_numbers())
up front, at build time -- live-measured 2026-07-15: ~1.5s for a genuinely
cold PDF fetch + pdftotext parse, ~0.5s or faster once NYPD's own CDN has
it warm, so a full citywide bake costs on the order of two minutes, paid
once per image build, never in a user's request path.

Crime is relative-to-NYC, not absolute (VISUAL.md §5, REVISED 2026-07-15).
Two reasons an absolute count misleads: it isn't normalised, so a dense or
commercial precinct logs more incidents without being more dangerous per
person; and on an absolute colour scale NYC's baseline is high everywhere,
so even the safest precinct reads alarming ("NYC just looks bad all
around" -- Noah, 2026-07-15). The fix: every precinct's raw YTD major-crime
count (`total_ytd`, the same number the safety card already headlines) is
placed on the citywide distribution via percentile_rank() below, so the
median precinct reads neutral/mid-scale and a place reads "lower than
most / about typical / higher than most of NYC" -- the question a resident
actually has, not "how big is this number in isolation."

**Denominator decision, live-checked, not assumed (2026-07-15): raw-count
percentile rank, NOT a per-capita rate.** Per-resident would be the more
meaningful number, but no NYPD/NYC Open Data dataset publishes a
population-per-precinct table -- confirmed by searching the live Socrata
catalog (`api.us.socrata.com/api/catalog/v1?q=...`) for "precinct
population", "population police precinct", and "police precinct" directly;
nothing matched. The closest real options, and why each was rejected:
  - NTA-level population (`swpk-hqdp`, `rnsn-acs2`) exists but is 2000/2010
    Census vintage -- 16-26 years stale as of this decision, and NTAs don't
    nest with precinct boundaries either, so it would need the same areal
    interpolation as the option below on top of already-stale numbers.
  - 2020 Census tract geometry (`63ge-mke6`) is live and current, but the
    dataset carries no population column at all -- getting tract population
    would mean pulling in the US Census Bureau's own API, a genuinely new
    external data source this codebase doesn't otherwise touch, then
    areal-interpolating (splitting each tract's population across whichever
    precincts its polygon overlaps, weighted by intersection area) under a
    uniform-population-density-within-a-tract assumption. That's a real
    engineering lift (a new API, a new join, real spatial-intersection
    logic) stacked on a real approximation (uniform density) -- exactly the
    "real lift or shaky interpolation" case the design brief itself said to
    fall back from. Not attempted this pass.
Falling back to rank-of-counts is still median-neutral and still far
better than an absolute scale -- it answers "does this precinct log more or
fewer major crimes than most of the city," just not "per resident." Stated
plainly to the reader via CRIME_RELATIVE_CAVEAT below, not shipped silently
as if it were a rate.
"""

import json

from bearings import config, staleness
from bearings.sources import compstat, neighborhoods, precincts

PATH = config.DERIVED_DIR / "citywide.json"

# Shown next to crime on both the map (legend/note) and the single-address
# safety card (SafetyCard.tsx) -- one string, cited from one place, per this
# codebase's own convention for shared copy (BASEMAP_NOTE, TRANSIT_CAVEAT).
# States the denominator decision plainly (see the module docstring above)
# and the plain, calm-voice caveat the design brief asked for: crime counts
# reflect reporting and policing intensity as well as public safety, and
# precinct boundaries are coarse.
CRIME_RELATIVE_CAVEAT = (
    "Shown as this precinct's percentile position among all NYC precincts, "
    "ranked by raw year-to-date major-crime count -- not a per-resident "
    "rate; NYC Open Data publishes no population figure per precinct. "
    "Reported counts reflect policing and reporting intensity as well as "
    "public safety, and precinct boundaries are coarse."
)


def percentile_rank(values: list[int], v: int) -> float:
    """Where `v` sits within `values`, as a 0-100 percentile: the share of
    `values` at or below `v`, with ties split evenly (v's own bucket counts
    as "equal", weighted 0.5) -- the same "mean rank" method
    `scipy.stats.percentileofscore(kind="mean")` uses. No new dependency:
    this is O(n) arithmetic over a 78-element in-memory list, not real
    numerical work.

    The 0.5 tie-split is what makes the sample MEDIAN land at (very close
    to) exactly 50 -- e.g. percentile_rank([10,20,30,40,50], 30) == 50.0 --
    which is the one property this module actually needs: VISUAL.md §5
    requires "the median precinct is neutral/mid-scale," not a min-max
    rescale that forces the single lowest precinct all the way to 0.
    """
    n = len(values)
    if n == 0:
        raise ValueError("percentile_rank of an empty distribution is undefined")
    below = sum(1 for x in values if x < v)
    equal = sum(1 for x in values if x == v)
    return 100.0 * (below + 0.5 * equal) / n


def _crime_for_precinct(pct: int) -> dict | None:
    """A precinct's CompStat summary, or None if the live fetch genuinely
    failed for that one precinct -- a broad except is deliberate here: one
    precinct's PDF 404ing, a transient nyc.gov error, or a parse surprise
    must not take down the whole citywide bake (78 independent live
    fetches; the odds that at least one has a bad day are real). Logged
    loudly, not swallowed silently. `None` -- never a fabricated 0 -- keeps
    this new field honest under this codebase's None-means-no-record rule.
    """
    try:
        d = compstat.fetch_precinct(pct)
    except Exception as e:  # noqa: BLE001 -- see docstring: intentionally broad
        print(f"citywide.py: precinct {pct} crime fetch failed, leaving crime=None ({e!r})")
        return None
    return {
        "week_ending": d["week_ending"],
        "robbery_ytd": d["robbery_ytd"],
        "felony_assault_ytd": d["felony_assault_ytd"],
        "total_ytd": d["total_ytd"],
    }


def _bake() -> dict:
    features = precincts.precinct_features()
    crime_by_precinct = {f["precinct"]: _crime_for_precinct(f["precinct"]) for f in features}

    # The full citywide distribution of real (non-None) YTD counts -- the
    # population percentile_rank() ranks every precinct against, including
    # itself. Computed once here, not once per precinct.
    totals = [c["total_ytd"] for c in crime_by_precinct.values() if c is not None]

    def _with_percentile(crime: dict | None) -> dict | None:
        if crime is None:
            return None
        return {**crime, "crime_percentile": percentile_rank(totals, crime["total_ytd"])}

    precinct_rows = [
        {**feature, "crime": _with_percentile(crime_by_precinct[feature["precinct"]])}
        for feature in features
    ]
    return {
        "neighborhoods": neighborhoods.labels(),
        "precincts": precinct_rows,
        "neighborhoods_source": dict(neighborhoods.SOURCE),
        "precincts_source": dict(precincts.SOURCE),
        "crime_source": dict(compstat.SOURCE),
        "crime_caveat": CRIME_RELATIVE_CAVEAT,
    }


def warm_caches() -> None:
    """Bake data/derived/citywide.json if it doesn't already exist. Called
    once by Dockerfile's build-time step and by api.py's startup handler
    (mirroring mapgeo.warm_caches()'s own pattern). Safe to call more than
    once -- a no-op once the file exists."""
    if PATH.exists():
        staleness.warn_if_stale(PATH, config.CITYWIDE_CACHE_MAX_AGE_S, "citywide map data")
        return
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(_bake()))


def get() -> dict:
    """The baked citywide map data. Requires warm_caches() to have run
    first -- raises FileNotFoundError otherwise (a loud, named guard),
    matching buildings.footprints_in_bbox()'s / streets.segments_in_bbox()'s
    own not-baked-yet behaviour."""
    if not PATH.exists():
        raise FileNotFoundError(
            f"{PATH} has not been baked yet -- call bearings.citywide."
            "warm_caches() first (Dockerfile's build-time step / api.py's "
            "startup handler do this automatically)."
        )
    return json.loads(PATH.read_text())
