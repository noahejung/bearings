"""311 heat/hot-water complaints, filtered to the legal heating season.

NYC's Housing Maintenance Code (Admin Code Sec. 27-2029) heating season
runs October 1 through May 31. `complaint_type` is confirmed live (not
guessed) to be `"HEAT/HOT WATER"` (all caps) -- the dominant, actively
filed value: 1.64M rows since 2020, still being filed as of the live
probe used to write this module. A short-lived mixed-case variant
`"Heat/Hot Water"` also exists (~1,800 rows, all filed Aug-Oct 2023 --
apparently a brief data-entry inconsistency, not a real distinct
category) -- both variants are matched so this doesn't silently miss
those rows. `"Non-Residential Heat"` is a real, separate complaint type
in this dataset and is deliberately excluded: it covers commercial
buildings, not the residential heating-season signal this module reports.

**This dataset carries a real `bbl` column** -- confirmed live, contrary
to this task's assumption that it might not. So `complaints()` joins
per-building on an exact `bbl` match whenever one is available, which is
the accurate join, not a proximity guess. `bbl` is null on a small share
of rows even within the heat complaint type (~0.35% in the most recent
season, confirmed live) -- 311's own geocoding gap on those specific
complaints, not something this module can recover.

When no BBL is available (`bbl_or_point` is a `(lat, lng)` tuple instead
of a BBL string), this falls back to a tight ~50m radius via
`within_circle`. That fallback answers a genuinely different question --
"heat complaints near this point," not "heat complaints in this
building" -- confirmed live to matter: the same hotspot building's own
point, at a 50m radius, picks up 2,693 complaints against a 2,401 exact
bbl match, because the radius also catches next-door buildings. The
result dict's `joined_on` field says which join was actually used, so a
caller can never present one as the other."""

from datetime import datetime, timezone

from bearings.sources import socrata

SOURCE = {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"}

_COMPLAINT_TYPES = "'HEAT/HOT WATER', 'Heat/Hot Water'"
_RADIUS_M = 50
_SEASON_START_MONTH = 10  # heating season opens Oct 1
_SEASON_END_MONTH = 5  # heating season closes May 31


def _season_bounds(seasons: int, now: datetime | None = None) -> tuple[str, str]:
    """(start, end) ISO timestamps ($where-ready, no timezone suffix --
    matches the format the rest of this codebase's `created_date`
    filters use) spanning the trailing `seasons` legal heating seasons.
    `end` is the most recent season's close: if `now` falls inside a
    season (Oct-May) that season is still open and counts as the most
    recent one; if `now` falls outside any season (Jun-Sep) the most
    recently *completed* season is the most recent one."""
    now = now or datetime.now(timezone.utc)

    if now.month >= _SEASON_START_MONTH or now.month <= _SEASON_END_MONTH:
        # Inside a season: Oct-Dec started this calendar year; Jan-May
        # started last calendar year.
        latest_start_year = now.year if now.month >= _SEASON_START_MONTH else now.year - 1
    else:
        # Outside any season (Jun-Sep): the most recent one closed May 31
        # this year, so it started last October.
        latest_start_year = now.year - 1

    earliest_start_year = latest_start_year - (seasons - 1)
    start = f"{earliest_start_year}-10-01T00:00:00"
    end = f"{latest_start_year + 1}-06-01T00:00:00"  # exclusive upper bound
    return start, end


def complaints(bbl_or_point: str | tuple[float, float], seasons: int = 1) -> dict:
    """Heat/hot-water 311 complaint count over the trailing `seasons`
    legal heating seasons (default: the current or most recently
    completed one).

    `bbl_or_point` is either a BBL string (exact per-building join, the
    preferred and accurate path) or a `(lat, lng)` tuple (falls back to a
    ~50m radius when no BBL is known -- see module docstring for why that
    is a different fact, not a substitute). The returned `joined_on`
    field ("bbl" or "point") makes which path ran explicit."""
    start, end = _season_bounds(seasons)

    if isinstance(bbl_or_point, str):
        location_clause = f"bbl='{bbl_or_point}'"
        joined_on = "bbl"
    else:
        lat, lng = bbl_or_point
        location_clause = f"within_circle(location, {lat}, {lng}, {_RADIUS_M})"
        joined_on = "point"

    where = (
        f"complaint_type in ({_COMPLAINT_TYPES}) "
        f"AND created_date >= '{start}' AND created_date < '{end}' "
        f"AND {location_clause}"
    )
    df = socrata.fetch("311", select="count(*)", where=where)
    count = int(df.iloc[0]["count"]) if not df.empty else 0

    return {
        "complaints": count,
        "seasons": seasons,
        "season_start": start[:10],
        "season_end": end[:10],
        "joined_on": joined_on,
        "source": dict(SOURCE),
    }
