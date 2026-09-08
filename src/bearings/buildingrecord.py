"""The per-building record behind `GET /api/building/{bbl}` -- five sources
this project already owns, none of which could reach a reader until now.

`sources/bedbugs.py`, `rodents.py`, `heat.py`, `flood.py` and `pavement.py`
have been built, tested against live data, and unreachable: their only caller
was `profile.profile_for()`, and `api.py`'s `_to_contract()` strips all five
out of `GET /api/profile`. SPEC-precompute-v2.md Phase 3 planned this
endpoint and it was never built (2026-08-11 codebase audit, finding M1).

Three states per field, and the distinction between them is the whole point
=========================================================================
Every field is exactly one of:

  * a real value,
  * `None` -- "we looked, and this source has no record for this building",
  * `{"unavailable": True, "reason": "..."}` -- "we could not look".

Conflating the second and third is this project's own recurring bug class.
`None` is not zero and "unavailable" is not "clean": a building whose rodent
lookup timed out has not passed an inspection, and a building that has never
filed a bedbug report is not a building that filed a report of zero.

`heat` is the one field that is never `None`, and that is a statement about
what the bake knows rather than a coercion: the bake counts the entire
citywide heating season, so a BBL absent from the file has a real, measured
zero -- "we looked at every heat complaint in the city and none of them name
this building". The same reasoning `sources/buildings.py`'s
`fetch_attributes()` already uses for `hazard_class_c`.

Bake vs. live, decided by measurement on 2026-09-07
===================================================
The rule (SPEC-building-card-v2.md): bake a source if its citywide pull
finishes in under ~5 minutes on the Docker build and the aggregate parquet is
under ~50 MB; otherwise serve it live with a short timeout, an `lru_cache`
keyed by BBL, and the `unavailable` shape on failure.

**BAKED -- bedbugs.** 720,493 rows citywide across 125,391 distinct BBLs.
One real 50,000-row page cost 2.62s at `$offset=0` and 5.36s at
`$offset=500000`, so 15 pages land near a minute. Comfortably inside the
budget.

**BAKED -- 311 heat/hot water.** 341,824 complaints in the closed
2025-10-01..2026-05-31 heating season, 340,628 of them carrying a BBL. One
page cost 22.86s at `$offset=0` and 1.83s at `$offset=300000` (this dataset
does not punish deep offsets), so 7 pages land near a minute.

**LIVE -- rodent inspections.** This is the one the spec predicted would
fail the rule, and it does, by a wide margin. 3,117,540 rows all-time;
360,651 in the trailing 24 months once filtered to the `Initial`/`Compliance`
inspection types that carry a real verdict. A plain paginated pull is not
viable: `$offset=0` cost 19.45s but `$offset=300000` cost **174.98s** on the
same query, so eight escalating pages land around 13 minutes. Date-chunking
the pull to keep every offset at zero was measured too, and it does not
rescue it -- three consecutive 90-day chunks cost 197.52s, 95.55s and 66.02s,
so eight chunks land between 6 and 13 minutes. The cost is Socrata's scan of
`inspection_type` over 3.1M rows, not the offset. So this source stays live:
a single-BBL query measured 0.16s-5.73s across ten live calls the same day
(median around 0.5s), which means the `unavailable` state is not decorative
-- roughly two calls in ten would exceed the 3s budget and say so.

**LIVE -- FEMA flood zone and DOT pavement.** Both are per-point lookups,
and this codebase has no spatial library, so there is no correct way to bake
them per BBL (the pavement bake was declined on exactly this ground on
2026-08-02; flood.py's own docstring makes the same call). Measured
2026-09-07: FEMA answered 12 of 12 probes in 0.14s-0.24s, DOT 8 of 8 in
0.22s-0.44s.

The three live sources run in parallel against one shared deadline, so this
endpoint's wall clock is bounded by its slowest single source rather than
their sum.

And one photograph, on a separate endpoint
==========================================
SPEC-building-card-v2.md Part B adds a Wikimedia Commons photo to the same
card. It is deliberately NOT a sixth field on `record_for()`: Commons is a
live external source measured at 0.67-1.13s per call, and folding it in
would add its latency to the response that carries the five hazard fields
and put its failures inside that payload. `photo_for()` below answers
`GET /api/building/{bbl}/photo` instead, with its own 2s budget and its own
`lru_cache`, so a slow or unreachable Commons delays nothing and poisons
nothing. The card fires both fetches at once and fills each block in as it
lands. See sources/commons.py for the API mechanics, all of which were
verified live before being written.

Why a per-request thread pool and not asyncio
=============================================
FastAPI already runs a synchronous endpoint in its own worker thread, and
all three live sources are synchronous `httpx` calls inside modules this
dispatch is not rewriting. Three short-lived threads per request is the
smaller change and the bounded one -- and it is only bounded because each
source's socket timeout is set explicitly (see `sources/socrata.py` and
`sources/flood.py`'s new timeout keywords). Waiting on a future does not
cancel the work behind it; a Python thread cannot be killed. If the socket
timeout were left at its 120s bake-path default, every timed-out click would
leave a thread alive for two minutes after its response had already been
sent, which on a 512MB Render instance is a real leak.
"""

import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache

import pandas as pd

from bearings import config, duckconn, staleness
from bearings.sources import (
    bedbugs,
    buildings,
    commons,
    flood,
    heat,
    pavement,
    rodents,
    socrata,
)

logger = logging.getLogger("bearings.buildingrecord")

_PATH = config.DERIVED_DIR / "building_hazards.parquet"
# A sidecar rather than extra constant-valued columns on every row: the
# windows below are properties of the bake, not of any one building, and
# repeating "seasons=1, season_start=2025-10-01" across 130,000 rows would be
# the same fact stored 130,000 times. Same shape as cellprofile.py's
# _manifest.json.
_META_PATH = config.DERIVED_DIR / "building_hazards.json"

# Every column the request path reads. staleness.require_baked_columns()
# raises BakedSchemaOutOfDate at boot if a file baked by older code is
# missing any of them -- see warm_cache().
BAKED_COLUMNS = {
    "bbl",
    "bedbug_filings",
    "bedbug_period_end",
    "bedbug_units_total",
    "bedbug_units_infested",
    "bedbug_units_reinfested",
    "bedbug_units_eradicated",
    "heat_complaints",
}

# One legal heating season (Oct 1 - May 31), matching sources/heat.py's own
# default and the season its live fixture is measured over.
HEAT_SEASONS = 1
# The trailing window rodents.inspections() counts over, restated here so the
# response can name the denominator behind "4 inspections".
RODENT_MONTHS = 24

HEAT_CAVEAT = (
    "311 could not attach a bbl to about 0.35% of this season's heat "
    "complaints, so a building's count can be short by its own share of "
    "those -- 311's geocoding gap, not a gap this project can close."
)

# The shared wall-clock budget for all three live sources together. Each one
# additionally bounds its own socket below this (see _live_blocks()), so the
# deadline is a backstop, not the primary mechanism.
LIVE_DEADLINE_S = 3.5

# Per-source socket budgets, each sized to fit inside LIVE_DEADLINE_S in the
# worst case, and each shaped to that source's own measured failure mode.
#
# FEMA fails by mid-handshake connection reset, not by responding slowly
# (flood.py's module docstring, measured repeatedly) -- and a reset fails in
# milliseconds, so three cheap attempts beat one long one: 0.9 + 0.1 + 0.9 +
# 0.2 + 0.9 = 3.0s worst case against a measured 0.14-0.24s normal.
_FLOOD_HTTP = {"timeout": 0.9, "attempts": 3, "retry_backoff_s": 0.1}
# Socrata fails by being slow, not by resetting (2026-09-07: a single 311
# query ranged 0.69s-21.62s in one afternoon). Retrying a slow server inside
# the same budget only shortens the one attempt that might have finished, so
# both Socrata-backed live sources get a single full-budget shot instead.
_SOCRATA_HTTP = {"timeout": 3.0, "attempts": 1, "retry_backoff_s": 0.0}

SOURCES = {
    "bedbugs": {**bedbugs.SOURCE, "baked": True},
    "rodents": {**rodents.SOURCE, "baked": False},
    "heat": {**heat.SOURCE, "baked": True},
    "flood": {**flood.SOURCE, "baked": False},
    "pavement": {**pavement.SOURCE, "baked": False},
}

# Deliberately NOT one of SOURCES above. The five there are the hazard record
# and share one deadline and one response; Wikimedia Commons is a sixth,
# slower, entirely optional source answered by its own endpoint so that a
# Commons outage cannot delay or blank a single hazard field. See photo_for()
# and GET /api/building/{bbl}/photo.
PHOTO_SOURCE = {**commons.SOURCE, "baked": False}


def is_wellformed_bbl(bbl: str) -> bool:
    """A BBL is borough (1-5) + 5-digit block + 4-digit lot, zero-padded --
    the shape geocode.py hands out and every dataset here joins on. Checked
    before any lookup so a garbage path segment produces a 404 with a real
    explanation rather than an empty-but-200 record that reads as "we looked
    and this building is clean"."""
    return len(bbl) == 10 and bbl.isdigit() and bbl[0] in "12345"


def _unavailable(reason: str) -> dict:
    return {"unavailable": True, "reason": reason}


# --------------------------------------------------------------------------
# The bake.
# --------------------------------------------------------------------------


def fetch_bedbug_aggregate() -> pd.DataFrame:
    """One row per BBL that has ever filed a bedbug report, carrying its
    filing count and its most recent filing's own numbers.

    Same "fetch every row, aggregate client-side in pandas" shape as
    hpd.citywide_open_class_c_counts() and for the same measured reason:
    Socrata's own server-side `$group` is not usable here (a `$select=bbl,
    count(*)&$group=bbl` against the 311 dataset returns HTTP 400 outright,
    confirmed live 2026-09-07, and HPD's own docstring records the same
    aggregate being unpaginatable on that dataset).

    `order=":id"` because this is a multi-page fetch baked to disk -- see
    socrata.fetch()'s docstring for the duplicate rows unordered pagination
    put in this repo's own baked building and street files.

    Note the live column name `filling_period_end_date` -- two Ls. That is
    the real column, not a typo introduced here; sources/bedbugs.py's own
    docstring records confirming it live.
    """
    raw = socrata.fetch(
        "bedbugs",
        select=(
            "bbl,filing_date,filling_period_end_date,of_dwelling_units,"
            "infested_dwelling_unit_count,re_infested_dwelling_unit,"
            "eradicated_unit_count"
        ),
        where="bbl IS NOT NULL",
        order=":id",
    )
    if raw.empty:
        return pd.DataFrame(columns=sorted(BAKED_COLUMNS - {"heat_complaints"}))

    raw = raw.sort_values("filing_date", ascending=False)
    counts = raw.groupby("bbl").size()
    latest = raw.groupby("bbl", as_index=False).first()

    def _int(series: pd.Series) -> pd.Series:
        return pd.to_numeric(series, errors="coerce").astype("Int64")

    return pd.DataFrame(
        {
            "bbl": latest["bbl"].astype(str),
            "bedbug_filings": _int(latest["bbl"].map(counts)),
            # The live value is an ISO timestamp at midnight for what is
            # really a date; the time-of-day part carries no information, so
            # it is trimmed exactly as sources/bedbugs.py already trims it.
            "bedbug_period_end": latest["filling_period_end_date"].astype(str).str[:10],
            "bedbug_units_total": _int(latest["of_dwelling_units"]),
            "bedbug_units_infested": _int(latest["infested_dwelling_unit_count"]),
            "bedbug_units_reinfested": _int(latest["re_infested_dwelling_unit"]),
            "bedbug_units_eradicated": _int(latest["eradicated_unit_count"]),
        }
    )


def fetch_heat_aggregate() -> tuple[pd.DataFrame, int, int]:
    """One row per BBL with at least one 311 heat/hot-water complaint in the
    trailing heating season, plus (total rows in the season, rows 311 could
    not attach a BBL to) for the bake's own metadata.

    The complaint-type filter and the season bounds are sources/heat.py's
    own, reused rather than restated, so this bake and that module's live
    per-building path can never drift into counting different things.

    A BBL absent from the returned frame has a real zero, not a missing
    value: this is a citywide count over a closed window. Callers must not
    turn that zero into `None`.
    """
    start, end = heat._season_bounds(HEAT_SEASONS)
    window = (
        f"complaint_type in ({heat._COMPLAINT_TYPES}) "
        f"AND created_date >= '{start}' AND created_date < '{end}'"
    )
    total = socrata.fetch("311", select="count(*)", where=window)
    total_rows = int(total.iloc[0]["count"]) if not total.empty else 0

    raw = socrata.fetch("311", select="bbl", where=f"{window} AND bbl IS NOT NULL", order=":id")
    if raw.empty:
        return pd.DataFrame({"bbl": [], "heat_complaints": []}), total_rows, total_rows

    counts = raw.groupby("bbl").size().reset_index(name="heat_complaints")
    counts["bbl"] = counts["bbl"].astype(str)
    counts["heat_complaints"] = counts["heat_complaints"].astype("Int64")
    return counts, total_rows, total_rows - int(len(raw))


def bake() -> dict:
    """Build data/derived/building_hazards.parquet and its sidecar metadata,
    and return the metadata. One row per BBL that has any bedbug filing or
    any heat complaint; a BBL in one but not the other keeps real nulls for
    the columns it has no record in, except `heat_complaints`, which is a
    real 0 (see this module's docstring)."""
    bedbug_frame = fetch_bedbug_aggregate()
    heat_frame, heat_total_rows, heat_unattributed = fetch_heat_aggregate()

    merged = bedbug_frame.merge(heat_frame, on="bbl", how="outer")
    merged["heat_complaints"] = merged["heat_complaints"].fillna(0).astype("Int64")

    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    buildings._write_parquet(merged, _PATH)

    start, end = heat._season_bounds(HEAT_SEASONS)
    meta = {
        "baked_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "rows": int(len(merged)),
        "bedbugs": {
            "bbls": int(len(bedbug_frame)),
            "source": dict(bedbugs.SOURCE),
        },
        "heat": {
            "bbls": int(len(heat_frame)),
            "seasons": HEAT_SEASONS,
            "season_start": start[:10],
            "season_end": end[:10],
            "season_rows": heat_total_rows,
            "rows_without_a_bbl": heat_unattributed,
            "caveat": HEAT_CAVEAT,
            "source": dict(heat.SOURCE),
        },
        # Recorded here so the file itself says which of the five sources it
        # does NOT contain, and why -- see this module's docstring for the
        # measurements.
        "served_live_not_baked": {
            "rodents": "a citywide pull measured 6-13 minutes on 2026-09-07",
            "flood": "per-point FEMA lookup; no spatial library in this codebase",
            "pavement": "per-point DOT line-geometry lookup; same reason",
        },
    }
    _META_PATH.write_text(json.dumps(meta))
    return meta


def warm_cache() -> None:
    """Bake the per-building hazard file if it isn't there yet. Called by
    Dockerfile's build-time step and by api.py's startup handler, mirroring
    every other warm_cache() here. Safe to call more than once -- a no-op
    once the file exists, which is exactly why a local checkout will not
    re-bake a file that is already on disk. Delete it to force a refresh."""
    if _PATH.exists():
        staleness.warn_if_stale(
            _PATH, config.BUILDING_HAZARDS_CACHE_MAX_AGE_S, "building hazards"
        )
        staleness.require_baked_columns(_PATH, BAKED_COLUMNS, "baked building hazards")
        if _META_PATH.exists():
            return
        # A file baked before the sidecar existed: the parquet is fine, only
        # the metadata is missing, and re-fetching 1M rows to recover a dozen
        # constants would be absurd. Loud about what it could not recover.
        logger.warning(
            "%s exists but %s does not -- the bake's own windows are unknown, so "
            "the endpoint will report them as null. Delete the parquet and re-run "
            "the bake to restore them.",
            _PATH,
            _META_PATH,
        )
        return
    bake()


@lru_cache(maxsize=1)
def bake_meta() -> dict:
    """The bake's own metadata: when it ran, what windows it counted over,
    and which sources it deliberately does not contain. `{}` when the sidecar
    is missing (see warm_cache()) -- never invented."""
    if not _META_PATH.exists():
        return {}
    return json.loads(_META_PATH.read_text())


# --------------------------------------------------------------------------
# The request path.
# --------------------------------------------------------------------------


@lru_cache(maxsize=512)
def _baked_row(bbl: str) -> dict | None:
    """This BBL's row from the baked file, or `None` if it has none. A single
    DuckDB point lookup through duckconn.connect() (threads=2) -- never a
    bare duckdb.connect(), whose 22-thread default is what OOMs a 512MB
    container (see duckconn.py's own measurement)."""
    if not _PATH.exists():
        raise FileNotFoundError(
            f"{_PATH} has not been baked yet -- call bearings.buildingrecord."
            "warm_cache() first (Dockerfile's build-time step / api.py's startup "
            "handler do this automatically)."
        )
    columns = sorted(BAKED_COLUMNS)
    con = duckconn.connect()
    try:
        row = con.execute(
            f"SELECT {', '.join(columns)} FROM read_parquet('{_PATH.as_posix()}') "
            "WHERE bbl = ? LIMIT 1",
            [bbl],
        ).fetchone()
    finally:
        con.close()
    if row is None:
        return None
    return dict(zip(columns, row, strict=True))


def _maybe_int(value: object) -> int | None:
    """A baked numeric cell as a real int, or `None` when it is genuinely
    absent. Guards NaN explicitly: pandas writes a missing integer as NaN
    unless the column is a nullable dtype, and `int(nan)` does not raise --
    it produces a garbage number."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    return int(value)


def _bedbug_block(row: dict | None) -> dict | None:
    if row is None:
        return None
    filings = _maybe_int(row.get("bedbug_filings"))
    if filings is None:
        return None
    return {
        "filings": filings,
        "period_end": row.get("bedbug_period_end"),
        "units_total": _maybe_int(row.get("bedbug_units_total")),
        "units_infested": _maybe_int(row.get("bedbug_units_infested")),
        "units_reinfested": _maybe_int(row.get("bedbug_units_reinfested")),
        "units_eradicated": _maybe_int(row.get("bedbug_units_eradicated")),
    }


def _heat_block(row: dict | None) -> dict:
    """Never `None` -- the bake counted the whole city for the whole season,
    so a BBL that isn't in the file has a measured zero. See this module's
    docstring."""
    meta = bake_meta().get("heat", {})
    count = 0 if row is None else (_maybe_int(row.get("heat_complaints")) or 0)
    return {
        "complaints": count,
        "seasons": meta.get("seasons", HEAT_SEASONS),
        "season_start": meta.get("season_start"),
        "season_end": meta.get("season_end"),
        "caveat": HEAT_CAVEAT,
    }


@lru_cache(maxsize=512)
def _rodents_for_bbl(bbl: str) -> dict | None:
    """Cached only on success: `lru_cache` stores a returned value but never
    an exception, so a timed-out lookup is retried on the next click rather
    than being remembered as an answer."""
    result = rodents.inspections(bbl, months=RODENT_MONTHS, **_SOCRATA_HTTP)
    if result is None:
        return None
    return {**result, "months": RODENT_MONTHS}


@lru_cache(maxsize=512)
def _flood_for_point(lat: float, lng: float) -> dict | None:
    result = flood.zone(lat, lng, **_FLOOD_HTTP)
    if result is None:
        return None
    return {k: v for k, v in result.items() if k != "source"}


@lru_cache(maxsize=512)
def _pavement_for_point(lat: float, lng: float) -> dict | None:
    result = pavement.near(lat, lng, **_SOCRATA_HTTP)
    if result is None:
        return None
    return {k: v for k, v in result.items() if k != "source"}


def _live_blocks(bbl: str, point: tuple[float, float] | None) -> dict:
    """Run the three live sources in parallel against one shared deadline and
    return each one's block in whichever of the three states it reached.

    The wall clock here is the slowest single source, not their sum. Each
    task's own socket timeout is set below LIVE_DEADLINE_S (see _FLOOD_HTTP /
    _SOCRATA_HTTP), so a task that loses the race is already finishing on its
    own rather than being abandoned mid-read -- waiting on a future does not
    cancel the work behind it.
    """
    if point is None:
        no_point = _unavailable(
            "no single baked building footprint represents this BBL, so there "
            "is no point to look up -- either no footprint carries it, or its "
            "footprints are spread too far apart to stand for one building "
            "(see sources/buildings.py's point_for_bbl)."
        )
        point_tasks: dict[str, object] = {}
        blocks: dict[str, object] = {"flood": no_point, "pavement": dict(no_point)}
    else:
        point_tasks = {"flood": _flood_for_point, "pavement": _pavement_for_point}
        blocks = {}

    # NOT `with ThreadPoolExecutor(...)`. That form calls shutdown(wait=True)
    # on exit, which joins every submitted thread -- so the deadline below
    # would correctly mark a hung source "unavailable" and then the response
    # would sit there anyway until the hung call finished. Measured while
    # writing this: with the context-manager form and all three live sources
    # forced to hang for 10s, the endpoint took 10.1s to return a payload
    # whose three live fields all already said "did not answer within 3s".
    # A guard that fires but does not release is not a guard.
    #
    # shutdown(wait=False) is safe here only because each task's own socket
    # timeout is set below LIVE_DEADLINE_S (see _FLOOD_HTTP/_SOCRATA_HTTP):
    # an abandoned thread finishes on its own within ~3s of the response,
    # rather than holding a 120s bake-path read open behind it.
    pool = ThreadPoolExecutor(max_workers=1 + len(point_tasks))
    try:
        futures = {"rodents": pool.submit(_rodents_for_bbl, bbl)}
        for key, fn in point_tasks.items():
            futures[key] = pool.submit(fn, point[0], point[1])

        start = time.monotonic()
        for key, future in futures.items():
            remaining = LIVE_DEADLINE_S - (time.monotonic() - start)
            try:
                blocks[key] = future.result(timeout=max(remaining, 0.0))
            except TimeoutError:
                blocks[key] = _unavailable(
                    f"{SOURCES[key]['name']} did not answer within "
                    f"{LIVE_DEADLINE_S:.1f}s. This is not a record of "
                    "'no problems found' -- the source was not reachable in time."
                )
            except Exception as exc:  # noqa: BLE001 -- any upstream failure is "unavailable"
                logger.info("live source %s failed for bbl %s: %r", key, bbl, exc)
                blocks[key] = _unavailable(
                    f"{SOURCES[key]['name']} could not be reached "
                    f"({type(exc).__name__}). This is not a record of "
                    "'no problems found'."
                )
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return blocks


def record_for(bbl: str) -> dict:
    """Everything this project knows about one building, in the three-state
    shape described in this module's docstring. Every top-level key is always
    present; a caller never has to tell a missing key from a null one."""
    row = _baked_row(bbl)
    point = buildings.point_for_bbl(bbl)
    live = _live_blocks(bbl, point)

    baked_as_of = bake_meta().get("baked_at")
    live_as_of = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    return {
        "bbl": bbl,
        "point": None if point is None else {"lat": point[0], "lng": point[1]},
        "bedbugs": _bedbug_block(row),
        "rodents": live["rodents"],
        "heat": _heat_block(row),
        "flood": live["flood"],
        "pavement": live["pavement"],
        "sources": {
            key: {**src, "as_of": baked_as_of if src["baked"] else live_as_of}
            for key, src in SOURCES.items()
        },
    }



# --------------------------------------------------------------------------
# The photo (SPEC-building-card-v2.md Part B), on its own endpoint.
# --------------------------------------------------------------------------


@lru_cache(maxsize=512)
def _photo_lookup(bbl: str) -> dict:
    """This BBL's Commons lookup, cached by BBL.

    The no-representative-point case returns a value rather than raising,
    because it is a stable fact read out of a baked file -- this BBL will
    still have no usable footprint on the next click, and re-deriving it is
    pointless. A Commons transport failure, by contrast, propagates out of
    this function so `lru_cache` never stores it: `lru_cache` remembers
    returned values and never exceptions, so a timed-out lookup is retried
    on the next click instead of being remembered as an answer. Same rule
    as _rodents_for_bbl() above.
    """
    point = buildings.point_for_bbl(bbl)
    if point is None:
        return {"point": None}
    result = commons.photo_near(point[0], point[1], timeout=commons.TIMEOUT_S)
    return {"point": point, **result}


def photo_for(bbl: str) -> dict:
    """A freely-licensed Wikimedia Commons photograph cataloged near this
    building, in the same three states record_for() uses.

    `photo` is a real file, or `None` meaning "we asked Commons and it has
    nothing within the radius that this card can display and attribute", or
    `{"unavailable": True, "reason": ...}` meaning "we could not ask". The
    second and third must never collapse into each other: telling a reader
    that Commons holds no photograph of their building when the request in
    fact failed is the same bug class as reporting a timed-out rodent lookup
    as a passed inspection.

    `candidates` and `usable` say how many files Commons returned and how
    many of those were displayable, so "Commons has nothing here" and
    "Commons has something here we cannot attribute" stay distinguishable in
    words. Both are `None` when the lookup was not answered -- we do not know
    the count, and 0 would claim we did.
    """
    as_of = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    envelope = {
        "bbl": bbl,
        "point": None,
        "photo": None,
        "candidates": None,
        "usable": None,
        "radius_m": commons.SEARCH_RADIUS_M,
        "source": {**PHOTO_SOURCE, "as_of": as_of},
    }

    try:
        result = _photo_lookup(bbl)
    except Exception as exc:  # noqa: BLE001 -- any upstream failure is "unavailable"
        logger.info("commons photo lookup failed for bbl %s: %r", bbl, exc)
        return {
            **envelope,
            "photo": _unavailable(
                f"{commons.SOURCE['name']} could not be reached "
                f"({type(exc).__name__}). This is not a record of "
                "'no photograph exists' -- the source was not reachable."
            ),
        }

    point = result["point"]
    if point is None:
        return {
            **envelope,
            "photo": _unavailable(
                "no single baked building footprint represents this BBL, so "
                "there is no point to search around -- either no footprint "
                "carries it, or its footprints are spread too far apart to "
                "stand for one building (see sources/buildings.py's "
                "point_for_bbl)."
            ),
        }

    return {
        **envelope,
        "point": {"lat": point[0], "lng": point[1]},
        "photo": result["photo"],
        "candidates": result["candidates"],
        "usable": result["usable"],
        "radius_m": result["radius_m"],
    }


__all__ = [
    "BAKED_COLUMNS",
    "HEAT_CAVEAT",
    "HEAT_SEASONS",
    "LIVE_DEADLINE_S",
    "PHOTO_SOURCE",
    "RODENT_MONTHS",
    "SOURCES",
    "bake",
    "bake_meta",
    "is_wellformed_bbl",
    "photo_for",
    "record_for",
    "warm_cache",
]
