"""Assemble the per-address profile.

Everything expensive (POI ingest, the transit graph, Dijkstra from each
anchor) is computed once and memoised. The two slowest pieces -- the POI
table (pulled from Overture over S3) and the anchor-time dict (a full
Dijkstra run from every anchor) -- are additionally persisted to
`config.DERIVED_DIR` as build-time artefacts: the first call in the data
directory's lifetime pays the real cost and writes the result to disk;
every call after that, in this run or a future one, loads it back in
milliseconds. `warm_caches()` is the seam the HTTP API (api.py) calls on
startup so the first real request is never the one paying for a cold
boot."""

import json
from functools import lru_cache

import duckdb
import pandas as pd

from bearings import cells, citywide, config, geocode, staleness, transit
from bearings.sources import (
    bedbugs,
    benches,
    compstat,
    flood,
    gtfs,
    heat,
    hpd,
    noise,
    overture,
    pavement,
    pluto,
    precincts,
    rodents,
    trees,
)
from bearings.transit import WALK_SPEED_MPS, _haversine_m

# A COUNT cap, not a distance cap -- only the N geometrically-nearest
# stations within STATION_SEARCH_M are ever passed to _to_anchors(), even
# when a farther-but-reachable station also sits inside that radius. This
# was 3 until 2026-07-18, when it was found to independently compound the
# gtfs.stations() dedup bug (see that module's docstring): with 3 of the
# Astoria (N/W) line's stations silently dropped from the transit graph,
# a 3-station cap meant western Long Island City cells picked all three of
# their geometrically-nearest (but broken) Astoria stations over four
# farther-but-healthy alternates that were also within STATION_SEARCH_M --
# 9 confirmed cell failures, on top of the dedup bug's own 48.
#
# Raised to 6, not removed, after measuring both the correctness and the
# cost live (2026-07-18):
#   - Correctness only ever improves or stays flat as the cap rises.
#     _to_anchors()/cellprofile._transit_by_cell() both take the *minimum*
#     ride time over the candidate list, independently per anchor -- adding
#     a candidate can lower that minimum or leave it unchanged, never raise
#     it. A wider net can only find an equal-or-better route, never a worse
#     one -- 3 was fragile specifically because it made correctness depend
#     on all 3 closest stations being healthy, which the Astoria case
#     proved false. 6 gives real margin against the same failure shape
#     recurring (one bad station among the geometrically-closest few)
#     without a second graph-connectivity bug required to trigger it.
#   - Cost is negligible even across the full ~7,000-cell bake. The
#     expensive part of a per-cell lookup is already the O(num_stations)
#     haversine scan against every station within STATION_SEARCH_M -- paid
#     identically regardless of this cap's value. Raising the cap only adds
#     a few more O(1) dict lookups per anchor in the downstream min-search.
#     Timed live against the real ~7,017-cell bake: cellprofile.
#     _transit_by_cell() over every real cell took ~10.4s at
#     NEAREST_STATION_COUNT=3 and ~6.7s at 6 -- no measurable regression
#     (the run-to-run variance here is larger than the delta).
#   - Not removed entirely (i.e. not "every station within
#     STATION_SEARCH_M"): dense Manhattan hubs have as many as 25-27
#     distinct named stations within 1200m (confirmed live: Times Sq,
#     Union Sq, Herald Sq, Fulton St all >= 25) -- nearest_stations is also
#     a *display* list (profile_for()'s API contract, factcheck.py's
#     "steps from the subway" check), and an uncapped list would turn that
#     into an unreadable 25+-row dump for exactly the addresses where it
#     matters least (Manhattan is already well-served; a longer list there
#     tells a reader nothing a 6-station list doesn't already say).
NEAREST_STATION_COUNT = 6
STATION_SEARCH_M = 1200.0

# Reason codes for an unreachable anchor (to_anchors[anchor] == -1) -- added
# 2026-07-18 to replace a single collapsed "-1" (and the frontend's single
# "no route found" string) with an honest, distinguishable explanation. See
# _anchor_result()'s docstring for exactly how each is decided, and this
# project's 2026-07-18 agent-report "no-route-copy-split" for the full
# rationale. Both are real, plain-language-register facts (VISUAL.md), not
# invented officialese:
#   - a station right there but on a network with no rail path to the rest
#     of the system (Staten Island Railway, today) is a very different fact
#     from "no station nearby at all", and collapsing them into one string
#     told a Staten Island resident their neighborhood was as transit-dead
#     as a genuine desert, which it isn't -- it's a real, permanent ferry
#     gap in this project's schedule data, not a judgment on the place.
NO_STATION_IN_RANGE = "no_station_in_range"
NO_RAIL_CONNECTION = "no_rail_connection"


class UnexplainedDisconnectedStation(RuntimeError):
    """A real station is unreachable from every one of the four anchors,
    and it doesn't belong to the one network gap this project currently
    knows about and has verified live (Staten Island Railway -- see
    `_disconnected_stop_ids()`). Raised, not silently folded into
    NO_RAIL_CONNECTION, because a silent new disconnection is exactly the
    shape of bug that orphaned the entire Astoria N/W line before the
    2026-07-18 `gtfs.stations()` dedup fix (see that module's own
    docstring) -- a loud, named failure here beats a plausible-but-wrong
    "no rail connection" label on a route a bug fix would actually
    restore. Mirrors `transit.py`'s own `AnchorSnapTooFar` -- same
    "loud guard over a silently-wrong plausible number" pattern, this
    project's own standing rule after that incident."""


# One merged citation for the building block: PLUTO supplies year_built/era,
# HPD supplies hpd_open_violations. The contract calls for a single source
# object here rather than one per field, so this borrows HPD's dataset URL
# (arbitrary choice between the two -- both are cited by name) rather than
# inventing a third URL that points at neither dataset.
_BUILDING_SOURCE = {"name": "NYC PLUTO + HPD", "url": hpd.SOURCE["url"]}

# Keyed by era ("prewar"/"postwar"/"modern"); None has no note -- there is
# nothing to say about an age we don't know. Prewar wording matches the
# API contract's example exactly; postwar/modern follow SPEC.md's framing
# of building age as an affordability *signal*, never a promise.
_ERA_NOTES = {
    "prewar": (
        "Pre-war walk-up stock often carries rent-stabilised units, so a "
        "cheap apartment may exist here. This is a signal, not a promise."
    ),
    "postwar": (
        "Mid-century construction is a mixed bag for rent stabilisation -- "
        "check the building's individual history rather than assuming from "
        "age alone. This is a signal, not a promise."
    ),
    "modern": (
        "Post-2000 construction rarely carries rent-stabilised units -- the "
        "price you see is close to the price you'll pay. This is a signal, "
        "not a promise."
    ),
}


_POIS_PATH = config.DERIVED_DIR / "pois.parquet"
_ANCHOR_TIMES_PATH = config.DERIVED_DIR / "anchor_times.json"


def _write_parquet(df: pd.DataFrame, path) -> None:
    """Write a DataFrame to Parquet via DuckDB -- already a dependency, so
    this needs no new package (pandas' own to_parquet requires pyarrow,
    which nothing here otherwise pulls in)."""
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.register("_df", df)
    con.execute(f"COPY _df TO '{path.as_posix()}' (FORMAT PARQUET)")
    con.close()


def _read_parquet(path) -> pd.DataFrame:
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{path.as_posix()}')").fetch_df()
    con.close()
    return df


@lru_cache(maxsize=1)
def _pois():
    """The Overture POI table -- ~478k rows pulled over S3, which is the
    single slowest thing this module does. Persisted to disk (see the
    module docstring) so only the very first boot ever pays for it."""
    if _POIS_PATH.exists():
        staleness.warn_if_stale(_POIS_PATH, config.POI_CACHE_MAX_AGE_S, "POI table")
        return _read_parquet(_POIS_PATH)
    df = overture.fetch_pois()
    _write_parquet(df, _POIS_PATH)
    return df


@lru_cache(maxsize=1)
def _stations():
    # Every feed, not just the subway -- an address near Newport should
    # see PATH stations in nearest_stations, not just whatever subway
    # happens to be 1200m away. Not persisted to disk: both GTFS zips are
    # already cached locally by sources/gtfs.py, so parsing them from disk
    # is already fast -- there's no cold-vs-warm gap here worth closing.
    return pd.concat([gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True)


@lru_cache(maxsize=1)
def _anchor_times():
    """{anchor: {stop_id: seconds}} -- a full Dijkstra run from every
    anchor over the whole transit graph. Persisted to disk for the same
    reason _pois() is: it's real work, and it never changes without a new
    GTFS feed, so there is no reason to redo it every boot."""
    if _ANCHOR_TIMES_PATH.exists():
        staleness.warn_if_stale(
            _ANCHOR_TIMES_PATH, config.ANCHOR_TIMES_CACHE_MAX_AGE_S, "anchor-times"
        )
        with _ANCHOR_TIMES_PATH.open() as f:
            raw = json.load(f)
        return {
            anchor: {stop: int(sec) for stop, sec in by_stop.items()}
            for anchor, by_stop in raw.items()
        }
    times = transit.times_from_anchors()
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    with _ANCHOR_TIMES_PATH.open("w") as f:
        json.dump(times, f)
    return times


@lru_cache(maxsize=1)
def _disconnected_stop_ids() -> frozenset[str]:
    """Every real station that is unreachable from all four anchors --
    computed once by diffing the full station table against the union of
    every anchor's own reachable-stop-id set in `_anchor_times()`. As of
    the 2026-07-18 dedup fix (see `gtfs.stations()`'s docstring) this set
    is exactly the 21 real Staten Island Railway stations, confirmed live:
    SIR has no rail path to the rest of NYCT, and the only way across is
    the Staten Island Ferry, which carries no GTFS schedule data this
    project has access to -- a real, permanent methodology gap, not a bug.

    Every stop_id in the returned set is asserted here to serve ONLY the
    real, rider-facing "SIR" route (`gtfs.stations()`'s own `routes`
    column, itself sourced from routes.txt's `route_short_name`) -- if a
    future GTFS update or code regression disconnects any OTHER station,
    that assertion fails with `UnexplainedDisconnectedStation` immediately
    at first use, rather than silently relabeling a brand-new routing
    defect as this project's one known, explained gap. Same "loud guard
    over a plausible-but-wrong number" pattern `transit.py`'s own
    `AnchorSnapTooFar` already established for anchor-snap distance.
    """
    at = _anchor_times()
    reachable: set[str] = set()
    for by_stop in at.values():
        reachable |= set(by_stop)

    st = _stations()
    routes_by_id = dict(zip(st["stop_id"], st["routes"], strict=True))
    disconnected = set(routes_by_id) - reachable

    for stop_id in disconnected:
        routes = routes_by_id.get(stop_id, [])
        if routes != ["SIR"]:
            raise UnexplainedDisconnectedStation(
                f"{stop_id!r} (serving routes={routes!r}) is unreachable "
                "from every anchor but does not serve only Staten Island "
                "Railway -- a new, unexplained network gap, not this "
                "project's one known, real ferry gap. Investigate before "
                "treating it as NO_RAIL_CONNECTION."
            )
    return frozenset(disconnected)


def warm_caches() -> None:
    """Populate every module-level cache profile_for() depends on: the POI
    table, the station tables, and the anchor-time dict (which builds the
    transit graph and runs Dijkstra as a side effect). Called once by
    api.py's startup handler so the first real HTTP request never pays the
    cold-boot cost. Safe to call more than once -- every cache here is
    memoised, so repeat calls are free.

    Also validates `_disconnected_stop_ids()` eagerly, here, rather than
    leaving it to fire lazily on whichever address or cell happens to be
    the first to hit an unreachable anchor -- a real network regression
    should surface loudly at boot, the same moment `_anchor_times()`
    itself would already fail on `AnchorSnapTooFar`, not buried inside a
    live request or a partway-through citywide bake.
    """
    _pois()
    _stations()
    _anchor_times()
    _disconnected_stop_ids()
    # LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A): the live routable
    # graph commute_to_point() below needs for a user-typed custom
    # destination -- warmed here for the same reason every cache above is
    # (real ~3.3s cost, see transit.graph()'s own docstring, paid once at
    # boot rather than inside whichever request happens to be first to add
    # a custom destination).
    transit.graph()


def _walk_minutes(metres: float) -> int:
    return int(round(metres / WALK_SPEED_MPS / 60))


def _nearby_stations(lat: float, lng: float) -> list[dict]:
    st = _stations()
    out = []
    for row in st.itertuples():
        d = _haversine_m((row.lat, row.lng), (lat, lng))
        if d <= STATION_SEARCH_M:
            out.append(
                {
                    "stop_id": row.stop_id,
                    "name": row.name,
                    "routes": list(row.routes),
                    "walk_minutes": _walk_minutes(d),
                    "_m": d,
                }
            )
    out.sort(key=lambda s: s["_m"])
    for s in out:
        s.pop("_m")
    return out[:NEAREST_STATION_COUNT]


def _best_candidate(
    candidates: list[tuple[str, int]], by_stop: dict[str, int]
) -> tuple[str, int, int, int] | None:
    """(stop_id, walk_minutes, ride_seconds, total_minutes) for the single
    winning candidate station -- the one scan `_anchor_result()` (which
    only needs the total) and Wave 4's `route_for()` (which also needs to
    know WHICH station won, to reconstruct a real path from it) both run.
    Factored out so they share one scan rather than two independently
    re-picking a minimum that could in principle disagree. None if no
    candidate has a real ride time (mirrors `_anchor_result()`'s own
    NO_RAIL_CONNECTION case)."""
    best: tuple[str, int, int, int] | None = None
    for stop_id, walk_minutes in candidates:
        ride_s = by_stop.get(stop_id)
        if ride_s is None:
            continue
        total = walk_minutes + int(round(ride_s / 60))
        if best is None or total < best[3]:
            best = (stop_id, walk_minutes, ride_s, total)
    return best


def _anchor_result(
    candidates: list[tuple[str, int]], by_stop: dict[str, int]
) -> tuple[int, str | None]:
    """One anchor's real (minutes, reason) result for one query point.

    `candidates` is a list of (stop_id, walk_minutes) pairs for every
    station the caller considers worth checking -- already filtered to
    STATION_SEARCH_M and capped to NEAREST_STATION_COUNT by the caller
    (this module's own `_nearby_stations()`, or cellprofile.py's
    `_transit_by_cell()`). Shared by both call sites so the reason logic
    lives in exactly one place -- both independently reimplemented the
    plain minutes computation before this function existed (see this
    project's 2026-07-18 "no-route-copy-split" agent-report).

    Returns (minutes, reason). `minutes` is -1 exactly when `reason` is
    not None -- the number and its explanation always come from the same
    scan, never two passes that could disagree:
      - NO_STATION_IN_RANGE when `candidates` is empty: no station was
        even found near enough to consider.
      - NO_RAIL_CONNECTION when candidates exist but none of them has a
        real ride time from this anchor -- every one sits on a network
        with no rail path here (Staten Island Railway, today).
        `_disconnected_stop_ids()` is called first for its own validating
        side effect (memoised, so free after the first real call): if any
        candidate here were NOT that one known, explained disconnection,
        that call raises `UnexplainedDisconnectedStation` before this
        function could mislabel a genuinely new bug.
      - `None` (a real route was found) otherwise.
    """
    if not candidates:
        return -1, NO_STATION_IN_RANGE

    best = _best_candidate(candidates, by_stop)
    if best is not None:
        return best[3], None

    _disconnected_stop_ids()  # validates every candidate above, or raises
    return -1, NO_RAIL_CONNECTION


def _to_anchors(nearby: list[dict]) -> tuple[dict[str, int], dict[str, str | None]]:
    """Total door-to-anchor minutes, plus (see `_anchor_result()`) a real
    reason whenever an anchor is unreachable -- the two returned dicts
    share the same keys and the same invariant `_anchor_result()`
    documents (a -1 and a non-None reason always travel together).

    We take the best station for each anchor independently -- the fastest
    way to Midtown may not start at the same station as the fastest way to
    WTC.
    """
    times = _anchor_times()
    candidates = [(s["stop_id"], s["walk_minutes"]) for s in nearby]

    minutes_out: dict[str, int] = {}
    reason_out: dict[str, str | None] = {}
    for anchor, by_stop in times.items():
        minutes, reason = _anchor_result(candidates, by_stop)
        minutes_out[anchor] = minutes
        reason_out[anchor] = reason

    return minutes_out, reason_out


# LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A+C): live single-
# destination commute for the editable getting-around region. The 4 baked
# ANCHORS keep their existing fast path (cellprofile.py's bake, served by
# GET /api/cell/{h3}) completely untouched -- this is a NEW call site for
# the exact same _anchor_result() machinery, applied to a destination the
# bake never covered, not new routing logic.
@lru_cache(maxsize=512)
def commute_to_point(cell: str, dest_lat: float, dest_lng: float) -> tuple[int, str | None]:
    """Real, live (minutes, reason) from `cell`'s own centroid to one
    user-chosen destination point.

    Mirrors cellprofile.py's own per-cell baked-anchor computation exactly
    on the origin side: the same cell centroid, the same
    _nearby_stations()/_anchor_result() calls the 4 baked anchors were
    computed with at build time (confirmed live 2026-08-03: calling this
    with one of the 4 real config.ANCHORS' own coordinates reproduces that
    cell's already-baked to_anchors[...] value exactly, for a real cell).
    The only difference is the destination side: transit.destination_times()
    (this module's own live mirror of transit.times_from_anchors(), run for
    one arbitrary point instead of the 4 curated ANCHORS) in place of the
    pre-baked anchor_times.json lookup.

    lru_cache'd on (cell, dest_lat, dest_lng) -- SPEC-layout-v3.md §5.2
    Option C's session-scoped cache: re-selecting the SAME custom
    destination for the SAME cell inside this process's lifetime is a
    cache hit (see this function's own `cache_info()`), never a second
    Dijkstra run. Keyed on the RESOLVED point, not the raw address string
    a caller searched -- two different strings that geocode to the same
    point (or the identical string re-geocoded, which geocode.py's own
    cache already makes a free dict lookup) both land on this same cache
    entry. maxsize=512 mirrors geocode.py's own address-lookup cache size
    -- generous for a single browsing session, not meant to hold citywide
    history.
    """
    lat, lng = cells.centroid(cell)
    nearby = _nearby_stations(lat, lng)
    candidates = [(s["stop_id"], s["walk_minutes"]) for s in nearby]

    by_stop = transit.destination_times(dest_lat, dest_lng, STATION_SEARCH_M)
    if by_stop is None:
        # No real station within STATION_SEARCH_M of the DESTINATION -- the
        # same honest "nothing nearby" fact _anchor_result() already
        # returns when the ORIGIN has no candidates, applied to the other
        # end of the trip. The existing frontend copy ("no subway or PATH
        # station within about a 15-minute walk") doesn't name which end
        # of the trip it's about, so reusing NO_STATION_IN_RANGE here
        # (rather than inventing a third reason code) stays honest without
        # new copy. One real, known asymmetry this creates, flagged rather
        # than papered over: NO_RAIL_CONNECTION's existing copy names
        # Staten Island Railway specifically, written for the case where
        # the ORIGIN is near SIR -- a custom DESTINATION that itself
        # resolves to an SIR station would surface NO_RAIL_CONNECTION too
        # (see destination_times()'s own docstring), with that copy
        # describing the wrong side of the trip. Rare (SIR is 21 of ~500
        # real stations) and still an honest "no real rail route" verdict,
        # not a fabricated number -- but not a perfectly-worded one for
        # that one edge case.
        return -1, NO_STATION_IN_RANGE

    return _anchor_result(candidates, by_stop)


# ---------------------------------------------------------------------------
# WAVE 4 (SPEC-layout-v3.md Wave 4): route-line preview + nav directions.
# Computed live, on demand, for BOTH the 4 baked ANCHORS and a custom
# destination -- unlike GET /api/cell/{h3}'s baked to_anchors minutes, no
# path/step data is baked (would bloat the citywide bake for a feature only
# requested when a user actually asks to see it -- toggling route lines on,
# or hovering/selecting a bar). Reuses `_best_candidate()`'s own scan (the
# SAME winning station `_anchor_result()`/`commute_to_point()` already
# picked) so the minutes this returns can never disagree with the minutes
# already shown on the bar -- both are the same one scan, not two.
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _station_index() -> dict[str, dict]:
    st = _stations()
    return {
        row.stop_id: {"name": row.name, "lat": row.lat, "lng": row.lng}
        for row in st.itertuples()
    }


def _station_name(stop_id: str) -> str:
    return _station_index().get(stop_id, {}).get("name", stop_id)


@lru_cache(maxsize=None)
def _anchor_stop_id(anchor: str) -> str:
    """The same station `times_from_anchors()` snapped this anchor to at
    bake time (`AnchorSnapTooFar`'s own guard already proved it's within
    MAX_ANCHOR_SNAP_M) -- times_from_anchors() never exposes the stop_id
    itself, only the resulting ride-time dict, so this recomputes the
    identical snap (cheap: a linear scan over ~500 graph nodes, not a
    Dijkstra run) rather than changing that function's return shape."""
    lat, lng = config.ANCHORS[anchor]
    return transit.nearest_stop(lat, lng)


def _steps_from_hops(hops: list[dict]) -> list[dict]:
    """transit.path_between()'s flat hop list -> the step sequence a rider
    actually experiences: consecutive "ride" hops that resolve to the SAME
    real GTFS route collapse into one "take this route" step (a rider does
    not re-board between two stops on the same train); a "transfer" hop, or
    a route change with no formal transfer edge between it (rare -- see
    gtfs.route_for_hop()'s own docstring on why two adjacent "ride" hops
    could in principle resolve to different routes), becomes its own step.
    Every route/shape_id/headsign named here comes from a real GTFS trip
    that actually makes that exact adjacent hop (gtfs.route_for_hop()) --
    never fabricated, never interpolated."""
    steps: list[dict] = []
    i, n = 0, len(hops)
    while i < n:
        hop = hops[i]
        if hop["kind"] == "transfer":
            steps.append(
                {"type": "transfer", "at": _station_name(hop["to"]), "minutes": _minutes_from_seconds(hop["seconds"])}
            )
            i += 1
            continue

        j = i
        seconds = 0.0
        shape_ids: set[str] = set()
        route: str | None = None
        headsign: str | None = None
        while j < n and hops[j]["kind"] == "ride":
            hj = hops[j]
            feed = gtfs.feed_for_stop(hj["from"])
            info = gtfs.route_for_hop(feed, hj["from"], hj["to"])
            hj_route = info["route"] if info else None
            if j == i:
                route = hj_route
                headsign = info["headsign"] if info else None
            elif hj_route != route:
                break
            seconds += hj["seconds"]
            if info and info["shape_id"]:
                shape_ids.add(info["shape_id"])
            j += 1

        steps.append(
            {
                "type": "ride",
                "route": route,
                "headsign": headsign,
                "from": _station_name(hops[i]["from"]),
                "to": _station_name(hops[j - 1]["to"]),
                "shape_ids": sorted(shape_ids),
                "minutes": _minutes_from_seconds(seconds),
            }
        )
        i = j
    return steps


def _minutes_from_seconds(seconds: float) -> int:
    return int(round(seconds / 60))


def route_for(
    cell: str,
    anchor: str | None = None,
    dest_lat: float | None = None,
    dest_lng: float | None = None,
) -> dict:
    """The real station-by-station steps + the GTFS shape_id(s) actually
    ridden, for either one of the 4 baked ANCHORS (`anchor=`) or a
    live-computed custom destination (`dest_lat=`/`dest_lng=`).

    Reachability (and `minutes`) is decided by the exact same
    `_best_candidate()` scan `_anchor_result()`/`commute_to_point()` use --
    this can never report "reachable" when the bar next to it says
    NO_STATION_IN_RANGE/NO_RAIL_CONNECTION, or vice versa, because both
    read the same one scan. `steps` is None whenever `reachable` is False:
    an honest "no route to describe" (matching the existing two-reason
    split), never a fabricated one.
    """
    lat, lng = cells.centroid(cell)
    nearby = _nearby_stations(lat, lng)
    candidates = [(s["stop_id"], s["walk_minutes"]) for s in nearby]

    if anchor is not None:
        by_stop = _anchor_times()[anchor]
        dest_stop_id = _anchor_stop_id(anchor)
        dest_point = config.ANCHORS[anchor]
    else:
        by_stop = transit.destination_times(dest_lat, dest_lng, STATION_SEARCH_M)
        dest_point = (dest_lat, dest_lng)
        if by_stop is None:
            return {"reachable": False, "reason": NO_STATION_IN_RANGE, "minutes": -1, "steps": None, "shape_ids": []}
        dest_stop_id = transit.nearest_stop(dest_lat, dest_lng)

    if not candidates:
        return {"reachable": False, "reason": NO_STATION_IN_RANGE, "minutes": -1, "steps": None, "shape_ids": []}

    best = _best_candidate(candidates, by_stop)
    if best is None:
        _disconnected_stop_ids()  # validates, or raises -- same guard _anchor_result() runs
        return {"reachable": False, "reason": NO_RAIL_CONNECTION, "minutes": -1, "steps": None, "shape_ids": []}

    origin_stop_id, walk_minutes, _ride_s, total_minutes = best
    hops = transit.path_between(origin_stop_id, dest_stop_id)
    if hops is None:
        # _best_candidate() found a real ride time, so this "should" never
        # happen -- but a route request is a caveat feature layered on top
        # of the existing minutes, never a reason to fabricate a path if
        # the two disagree. Surface it as unreachable, honestly, not a 500.
        return {"reachable": False, "reason": NO_RAIL_CONNECTION, "minutes": -1, "steps": None, "shape_ids": []}

    steps = [{"type": "walk_to_station", "to": _station_name(origin_stop_id), "minutes": walk_minutes}]
    steps += _steps_from_hops(hops)

    last_stop_id = hops[-1]["to"] if hops else origin_stop_id
    last_station = _station_index().get(last_stop_id, {})
    last_ll = (last_station.get("lat", dest_point[0]), last_station.get("lng", dest_point[1]))
    walk_out_m = _haversine_m(last_ll, dest_point)
    steps.append(
        {
            "type": "walk_to_destination",
            "minutes": _walk_minutes(walk_out_m),
            "estimated": True,
        }
    )

    shape_ids = sorted({sid for step in steps if step["type"] == "ride" for sid in step["shape_ids"]})
    return {
        "reachable": True,
        "reason": None,
        "minutes": total_minutes,
        "steps": steps,
        "shape_ids": shape_ids,
    }


def _amenities(cell: str) -> dict[str, int]:
    ring = set(cells.neighbors(cell, k=1))
    near = _pois()[_pois()["cell"].isin(ring)]
    counts = near["category"].value_counts().to_dict()
    counts.pop("other", None)
    return {k: int(v) for k, v in counts.items()}


@lru_cache(maxsize=128)
def _crime(pct: int) -> dict:
    return compstat.fetch_precinct(pct)


def _crime_percentile(total_ytd: int) -> float | None:
    """This precinct's percentile position (0-100, median-neutral) against
    every other real precinct's own YTD major-crime count -- crime is
    relative-to-NYC, never an absolute count on its own (VISUAL.md §5). See
    citywide.percentile_rank()'s docstring for the exact method and
    citywide.py's module docstring for why raw counts, not a per-capita
    rate, are the denominator (no NYPD/NYC Open Data precinct-population
    table exists -- checked live, not assumed).

    citywide.warm_caches() is a no-op once data/derived/citywide.json
    already exists (the common case: api.py's lifespan startup bakes it
    before any request can arrive) -- called here too so the CLI path
    (bearings.cli, which never calls citywide.warm_caches() itself) still
    gets a real percentile rather than a crash, at the cost of paying the
    citywide bake once on a genuinely fresh data/ directory, same tradeoff
    _pois()/_anchor_times() already make for their own first call.
    """
    citywide.warm_caches()
    totals = [
        p["crime"]["total_ytd"] for p in citywide.get()["precincts"] if p["crime"] is not None
    ]
    if not totals:
        return None
    return citywide.percentile_rank(totals, total_ytd)


def _safety(lat: float, lng: float) -> dict:
    pct = precincts.precinct_for(lat, lng)
    if pct is None:
        return {}

    c = _crime(pct)
    return {
        "precinct": pct,
        "week_ending": c["week_ending"],
        "robbery_ytd": c["robbery_ytd"],
        "robbery_pct": c["robbery_pct"],
        "felony_assault_ytd": c["felony_assault_ytd"],
        "felony_assault_pct": c["felony_assault_pct"],
        "total_ytd": c["total_ytd"],
        "total_pct": c["total_pct"],
        "crime_percentile": _crime_percentile(c["total_ytd"]),
    }


@lru_cache(maxsize=256)
def _quiet(lat: float, lng: float) -> dict:
    return {
        "noise_complaints_12mo": noise.complaints_near(lat, lng),
        "source": dict(noise.SOURCE),
    }


@lru_cache(maxsize=256)
def _green(lat: float, lng: float) -> dict:
    return {
        "street_trees_nearby": trees.near(lat, lng),
        "source": dict(trees.SOURCE),
    }


@lru_cache(maxsize=256)
def _pluto_building(bbl: str) -> dict:
    return pluto.building(bbl)


@lru_cache(maxsize=256)
def _hpd_violations(bbl: str) -> dict:
    return hpd.open_violations(bbl)


def _building(bbl: str | None) -> dict:
    # No BBL means genuinely no way to look this building up -- every field
    # here must be null, never a guessed or zeroed value.
    if bbl is None:
        year_built, era, violations = None, None, None
    else:
        b = _pluto_building(bbl)
        year_built, era = b["year_built"], b["era"]
        violations = _hpd_violations(bbl)

    return {
        "year_built": year_built,
        "era": era,
        "era_note": _ERA_NOTES.get(era),
        "hpd_open_violations": violations,
        "source": dict(_BUILDING_SOURCE),
    }


@lru_cache(maxsize=256)
def _bedbugs_report(bbl: str) -> dict | None:
    return bedbugs.report(bbl)


@lru_cache(maxsize=256)
def _rodent_inspections(bbl: str) -> dict | None:
    return rodents.inspections(bbl)


@lru_cache(maxsize=256)
def _flood_zone(lat: float, lng: float) -> dict | None:
    return flood.zone(lat, lng)


def _bedbugs(bbl: str | None) -> dict:
    """Mirrors `_building()`'s no-BBL handling exactly: no BBL means no way
    to look this building up at all, so `report` is null. This does
    collapse two different facts into the same `None` at this layer --
    "never checked" (no BBL) vs. "checked, this building has never filed"
    (bedbugs.report()'s own None) -- but that is the same tradeoff
    `_building()`'s `year_built` already makes (PLUTO's own "not recorded"
    sentinel and "no BBL at all" both surface as `None` there too), so this
    matches an existing, already-shipped convention rather than inventing a
    new three-state shape nothing else in this codebase uses."""
    return {
        "report": None if bbl is None else _bedbugs_report(bbl),
        "source": dict(bedbugs.SOURCE),
    }


def _rodents(bbl: str | None) -> dict:
    """See `_bedbugs()`'s docstring for the no-BBL-vs-never-inspected
    collapse -- same tradeoff, same reasoning."""
    return {
        "inspections": None if bbl is None else _rodent_inspections(bbl),
        "source": dict(rodents.SOURCE),
    }


def _heat(bbl: str | None, lat: float, lng: float) -> dict:
    """heat.complaints() already returns a complete, self-describing dict
    (its own `source` included) -- prefer the exact per-building BBL join,
    and fall back to the ~50m point radius only when no BBL is known. This
    never silently guesses: `joined_on` in the returned dict says which
    path actually ran, so a caller can never mistake "near this point" for
    "in this building" (see heat.py's own docstring)."""
    return heat.complaints(bbl if bbl is not None else (lat, lng))


def _flood(lat: float, lng: float) -> dict:
    """Point-based, not BBL-based -- always computed, since every profile
    has a real (lat, lng) even when the geocoder returns no BBL. `zone` is
    `None` when no FEMA NFHL study covers this point (a different fact from
    "studied, Zone X" -- see flood.py's own docstring), but `source` is
    still attached either way: the FEMA lookup genuinely ran."""
    return {
        "zone": _flood_zone(lat, lng),
        "source": dict(flood.SOURCE),
    }


@lru_cache(maxsize=256)
def _benches_near(lat: float, lng: float) -> dict:
    """benches.near() already returns a complete, self-describing dict
    (its own `source` included, benches/leaning_bars split apart) --
    always computed, point-based, matching flood's own "every profile has
    a real (lat, lng)" reasoning."""
    return benches.near(lat, lng)


@lru_cache(maxsize=256)
def _pavement_near(lat: float, lng: float) -> dict | None:
    """pavement.near() already returns a complete, self-describing dict, or
    `None` when no segment near this point has ever carried a real rating
    (see pavement.py's own docstring on the systemrating=0 sentinel this
    module already filters out) -- never a fabricated zero."""
    return pavement.near(lat, lng)


def profile_for(address: str) -> dict:
    loc = geocode.geocode(address)
    cell = cells.cell_for(loc.lat, loc.lng)
    nearby = _nearby_stations(loc.lat, loc.lng)
    to_anchors, unreachable_reason = _to_anchors(nearby)

    return {
        "address": loc.label,
        "cell": cell,
        "shard": cells.shard_for(cell),
        "location": {"lat": loc.lat, "lng": loc.lng, "bbl": loc.bbl},
        "transit": {
            "nearest_stations": nearby,
            "to_anchors": to_anchors,
            "unreachable_reason": unreachable_reason,
        },
        "amenities": _amenities(cell),
        "safety": _safety(loc.lat, loc.lng),
        "quiet": _quiet(loc.lat, loc.lng),
        "green": _green(loc.lat, loc.lng),
        "building": _building(loc.bbl),
        "bedbugs": _bedbugs(loc.bbl),
        "rodents": _rodents(loc.bbl),
        "heat": _heat(loc.bbl, loc.lat, loc.lng),
        "flood": _flood(loc.lat, loc.lng),
        "benches": _benches_near(loc.lat, loc.lng),
        "pavement": _pavement_near(loc.lat, loc.lng),
    }
