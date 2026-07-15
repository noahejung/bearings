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
"""

import json

from bearings import config, staleness
from bearings.sources import compstat, neighborhoods, precincts

PATH = config.DERIVED_DIR / "citywide.json"


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
    precinct_rows = [
        {**feature, "crime": _crime_for_precinct(feature["precinct"])}
        for feature in precincts.precinct_features()
    ]
    return {
        "neighborhoods": neighborhoods.labels(),
        "precincts": precinct_rows,
        "neighborhoods_source": dict(neighborhoods.SOURCE),
        "precincts_source": dict(precincts.SOURCE),
        "crime_source": dict(compstat.SOURCE),
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
