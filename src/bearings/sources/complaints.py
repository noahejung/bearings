"""NYPD Complaint Data -- individual reported incidents, for a block-level
(H3 res-9) crime signal finer-grained than compstat.py's per-precinct PDF
summary.

**Two live datasets, not one, live-verified 2026-08-02 (not trusted from a
dispatch premise) via `api.us.socrata.com/api/catalog/v1?ids=...` plus a
direct `$limit=5`/`min`/`max` schema probe against the real data endpoint:**

  - `qgea-i56i` "NYPD Complaint Data Historic" -- catalog `data_updated_at`
    2026-04-28. Its own catalog *description* text is stale boilerplate
    ("...to the end of last year (2019)"), years out of date and NOT
    trusted here -- a live `min/max(cmplnt_fr_dt)` probe shows the dataset's
    real content runs 2006 through 2025-12-31.
  - `5uac-w243` "NYPD Complaint Data Current (Year To Date)" -- catalog
    `data_updated_at` 2026-07-27 (same stale-description caveat as above).
    Real content is this calendar year's rows, but a live probe found a
    handful of garbage/legacy-dated outliers mixed in too (one row's
    `cmplnt_fr_dt` came back "1016-04-30", an obvious four-digit-year typo,
    and other genuine pre-2026 dates exist alongside it) -- `citywide_points
    ()`'s own year-boundary split (see `_year_boundary()`) excludes all of
    these by construction, not by trusting either dataset's nominal scope.

Both datasets carry real `latitude`/`longitude` text columns (confirmed
live via a `$limit=5` schema probe on each). NYPD snaps a meaningful share
of complaint coordinates to a small number of shared points rather than
each incident's exact location -- confirmed live 2026-08-02: querying one
precinct's 2025 robbery rows grouped by (latitude, longitude) surfaces
points shared by 4-8 separate complaints each, not a coincidence at this
volume. This is exactly why `cellprofile.py`'s block-crime bake sums a
k-ring neighbourhood around each cell rather than trusting a single H3
res-9 cell's raw count alone -- see that module's own docstring for the
smoothing design and the ring-size justification.

**Offense scope, chosen to keep comparability with the existing precinct
figure (per the 2026-08-02 dispatch's own instruction):** the same seven
NYPD "major felony" categories CompStat's own `TOTAL` row already sums
(`compstat.py`'s `_ytd(text, "TOTAL")`) -- confirmed live via `$select=
distinct ofns_desc where law_cat_cd='FELONY'` against both datasets:
MURDER & NON-NEGL. MANSLAUGHTER, RAPE, ROBBERY, FELONY ASSAULT, BURGLARY,
GRAND LARCENY, GRAND LARCENY OF MOTOR VEHICLE."""

from datetime import datetime, timedelta, timezone

import pandas as pd

from bearings.sources import socrata

SOURCE = {
    "name": "NYPD Complaint Data (Historic + Current YTD)",
    "url": "https://data.cityofnewyork.us/d/qgea-i56i",
}

# CompStat's own "seven major felony offenses" -- see module docstring for
# how this was confirmed live against the real `ofns_desc` values, not
# assumed from NYPD's public-facing "index crime" name for the same set.
MAJOR_FELONY_OFFENSES = (
    "MURDER & NON-NEGL. MANSLAUGHTER",
    "RAPE",
    "ROBBERY",
    "FELONY ASSAULT",
    "BURGLARY",
    "GRAND LARCENY",
    "GRAND LARCENY OF MOTOR VEHICLE",
)

# 24 months: long enough that a ~7,000-cell citywide bucketing (further
# split into ~7-cell smoothing windows, see cellprofile.py) has a real
# sample to rank against per cell -- live-measured 2026-08-02: the seven
# major-felony categories alone run ~240k rows over the trailing ~30
# months, so 24 months comfortably clears "more than a handful per cell"
# even before smoothing. Noah's own 2026-08-02 direction ("freshness for
# crime isn't too important, smoothing yes") is why this window favours
# sample size over recency -- unlike CompStat's own weekly-republished
# precinct PDF, this figure is not meant to track week-to-week change.
# Public (no leading underscore): cellprofile.py cites this exact number in
# the baked `block_crime.lookback_months` field, so it must be one real
# constant, not a second hardcoded copy that could drift from this one.
LOOKBACK_MONTHS = 24


def _offense_where() -> str:
    quoted = ",".join(f"'{o}'" for o in MAJOR_FELONY_OFFENSES)
    return f"ofns_desc in({quoted})"


def _year_boundary() -> str:
    """January 1 of the current calendar year, in Socrata floating-timestamp
    format -- the real, live-confirmed split point between the two
    datasets (see module docstring: "Current (Year To Date)" only ever
    holds this year's rows by the time a new year starts, the prior year
    having rolled into "Historic"). Computed at call time from the real
    clock, not hardcoded, so this keeps splitting correctly every January
    with no code change -- the same self-resolving pattern `config.py`'s
    own `OVERTURE_RELEASE`/`PMTILES_BUILD_LOOKBACK_DAYS` already use for
    the same reason (a hardcoded year/date silently goes stale)."""
    year = datetime.now(timezone.utc).year
    return f"{year}-01-01T00:00:00"


def citywide_points(lookback_months: int = LOOKBACK_MONTHS) -> pd.DataFrame:
    """Every major-felony complaint's raw (lat, lng) citywide in the
    trailing `lookback_months`, combining both live datasets with **no
    overlap and no double-count**: Historic is queried only for rows
    strictly before this year's January 1 boundary, Current YTD only for
    rows on or after it (see `_year_boundary()`) -- a real, derived split,
    not an assumption that the two datasets' own nominal coverage windows
    line up cleanly (Current YTD was confirmed live to carry a handful of
    rows outside its nominal "this year" scope, which this same boundary
    filter also excludes as a side effect).

    For the per-cell precompute bake (`bearings.cellprofile`), which needs
    the whole citywide set to bucket by H3 cell, not one bbox-scoped page
    -- mirrors `sources/trees.py`'s/`sources/benches.py`'s own
    `citywide_points()` shape (no pagination cap; `socrata.fetch()`'s own
    built-in paging handles the ~150-250k row volume across both
    datasets)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_months * 30)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    boundary = _year_boundary()
    offense_where = _offense_where()

    historic = socrata.fetch(
        "crime_historic",
        select="latitude,longitude",
        where=(
            f"{offense_where} AND cmplnt_fr_dt >= '{cutoff}' "
            f"AND cmplnt_fr_dt < '{boundary}'"
        ),
    )
    current = socrata.fetch(
        "crime_current",
        select="latitude,longitude",
        where=f"{offense_where} AND cmplnt_fr_dt >= '{boundary}'",
    )
    df = pd.concat([historic, current], ignore_index=True)
    if df.empty:
        return pd.DataFrame({"lat": pd.Series(dtype=float), "lng": pd.Series(dtype=float)})

    lats = pd.to_numeric(df["latitude"], errors="coerce")
    lngs = pd.to_numeric(df["longitude"], errors="coerce")
    out = pd.DataFrame({"lat": lats, "lng": lngs}).dropna()
    return out.reset_index(drop=True)
