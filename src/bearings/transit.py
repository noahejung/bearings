"""GTFS -> a weighted graph -> real travel times.

Every listings site tells you the distance to the subway. None of them tell
you how long it takes to get where you're actually going. The MTA publishes
the timetable; this module reads it."""

import math
from functools import lru_cache

import networkx as nx
import pandas as pd

from bearings import cells, config
from bearings.sources import gtfs

# The one citation for every transit fact this module produces (station
# names, routes, walk times, ride times) -- both api.py (the report cards)
# and factcheck.py (the "steps from the subway" claim) point here, so there
# is exactly one URL to keep correct.
SOURCE = {
    "name": "MTA GTFS + PATH GTFS",
    "url": "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
}

# Shared by both /api/profile (api.py's _to_contract) and the per-cell
# precompute (cellprofile.py) -- one string, cited from one place, per this
# codebase's own convention for shared copy (BASEMAP_NOTE, TRANSIT_CAVEAT
# used to be an api.py-local literal only the address-level endpoint saw).
TRANSIT_CAVEAT = (
    "Train time, plus a few minutes per transfer. Excludes the walk to "
    "the station and the wait for a train — the fastest possible time, "
    "not a real door-to-door estimate."
)

WALK_SPEED_MPS = 1.35        # ~4.9 km/h, a normal walking pace
TRANSFER_PENALTY_S = 240     # 4 min: walk between platforms + wait for a train
TRANSFER_MAX_M = 200.0       # stations closer than this are considered connected
MAX_ANCHOR_SNAP_M = 400.0    # beyond this, the anchor's real network is missing


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two (lat, lng) points."""
    r = 6_371_000.0
    lat1, lng1 = math.radians(a[0]), math.radians(a[1])
    lat2, lng2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _ride_times(feed: str) -> pd.DataFrame:
    """Median seconds between every pair of adjacent stations, from the
    timetable of a single feed.

    Median rather than mean: express and local trips share track, and the
    occasional pathological schedule row would drag a mean around.
    """
    st = gtfs.stop_times(feed).sort_values(["trip_id", "seq"])

    st["next_stop"] = st.groupby("trip_id")["stop_id"].shift(-1)
    st["next_arrival"] = st.groupby("trip_id")["arrival"].shift(-1)
    st["ride"] = st["next_arrival"] - st["departure"]

    legs = st.dropna(subset=["next_stop", "ride"])
    legs = legs[(legs["ride"] > 0) & (legs["ride"] < 3600)]

    return (
        legs.groupby(["stop_id", "next_stop"])["ride"]
        .median()
        .reset_index()
        .rename(columns={"stop_id": "src", "next_stop": "dst", "ride": "seconds"})
    )


def build_graph() -> nx.DiGraph:
    """One graph, built from every feed in gtfs.FEEDS.

    Each feed contributes its own stations and ride edges (its own
    timetable never mixes with another feed's). Transfer edges are then
    computed once, over every station regardless of feed -- this is
    deliberate: it's the only place a PATH platform and a subway platform
    are ever compared, and it's how the two networks connect (e.g. PATH's
    World Trade Center to the subway's) without any feed-pair-specific
    code. Namespaced stop_ids (gtfs._namespaced) make this safe -- a PATH
    station and an MTA station can never collide on ID even if some future
    feed reused a number.
    """
    g = nx.DiGraph()

    all_stations = pd.concat(
        [gtfs.stations(feed) for feed in gtfs.FEEDS], ignore_index=True
    )
    for row in all_stations.itertuples():
        g.add_node(row.stop_id, name=row.name, lat=row.lat, lng=row.lng, cell=row.cell)

    # Riding edges, straight from each feed's own timetable.
    for feed in gtfs.FEEDS:
        for leg in _ride_times(feed).itertuples():
            if leg.src in g and leg.dst in g:
                g.add_edge(leg.src, leg.dst, weight=float(leg.seconds), kind="ride")

    # Transfer edges: any two stations (same feed or different) close
    # enough to walk between.
    coords = {r.stop_id: (r.lat, r.lng) for r in all_stations.itertuples()}
    ids = list(coords)
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            d = _haversine_m(coords[a], coords[b])
            if d <= TRANSFER_MAX_M:
                w = d / WALK_SPEED_MPS + TRANSFER_PENALTY_S
                g.add_edge(a, b, weight=w, kind="transfer")
                g.add_edge(b, a, weight=w, kind="transfer")

    return g


def _nearest_station(graph: nx.DiGraph, lat: float, lng: float) -> str:
    return min(
        graph.nodes,
        key=lambda n: _haversine_m(
            (graph.nodes[n]["lat"], graph.nodes[n]["lng"]), (lat, lng)
        ),
    )


class AnchorSnapTooFar(Exception):
    """An anchor's nearest station in the graph is implausibly far away —
    almost certainly because the transit network actually serving that
    anchor is missing from the graph, not because the anchor is genuinely
    unserved. A 2,367m silent snap once made Times Sq -> Newport read as
    8.5 minutes. Fail loudly instead."""


def times_from_anchors() -> dict[str, dict[str, int]]:
    """{anchor: {stop_id: seconds}} — the ride time from every station to each
    anchor. Run once, offline. This is the whole point of precomputation."""
    graph = build_graph()
    reverse = graph.reverse(copy=True)  # we want time *to* the anchor

    out: dict[str, dict[str, int]] = {}
    for name, (lat, lng) in config.ANCHORS.items():
        target = _nearest_station(graph, lat, lng)
        d = _haversine_m((graph.nodes[target]["lat"], graph.nodes[target]["lng"]), (lat, lng))
        if d > MAX_ANCHOR_SNAP_M:
            raise AnchorSnapTooFar(
                f"anchor {name!r} at ({lat}, {lng}) snapped to "
                f"{graph.nodes[target]['name']!r} ({target}), {d:.0f}m away, "
                f"which exceeds MAX_ANCHOR_SNAP_M={MAX_ANCHOR_SNAP_M:.0f}m — "
                "the network actually serving this anchor is missing from the graph"
            )
        lengths = nx.single_source_dijkstra_path_length(reverse, target, weight="weight")
        out[name] = {stop: int(round(sec)) for stop, sec in lengths.items()}

    return out


# ---------------------------------------------------------------------------
# LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A): live commute compute
# for a user-typed destination the 4 curated ANCHORS above don't cover.
# times_from_anchors() itself is untouched -- that bake stays the fast path
# for the 4 defaults, unchanged. destination_times() below is the same
# "snap to nearest station, reverse-Dijkstra from it" method applied to one
# arbitrary point instead, at request time.
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def graph() -> nx.DiGraph:
    """The live routable graph, built once per process and memoised in
    memory -- NOT persisted to disk the way times_from_anchors()'s own
    anchor_times.json is (a nx.DiGraph isn't JSON-serialisable and this
    codebase has no pickle-cache convention). Backs destination_times()
    below. Real cost, measured live 2026-08-03 on this dev machine: ~3.3s
    (parsing both feeds' GTFS zips, mostly stop_times.txt), paid once --
    profile.warm_caches() calls this eagerly at process boot (api.py's
    lifespan startup handler already blocks on warm_caches() before the
    server opens its listening socket), so this cost lands at boot, never
    inside a live request, matching this codebase's own established
    "nothing pays the cold-boot cost at request time" rule for every other
    warm_caches() cache (_pois(), _anchor_times(), etc.)."""
    return build_graph()


@lru_cache(maxsize=1)
def _reverse_graph() -> nx.DiGraph:
    """graph().reverse(copy=True), memoised the same way graph() is --
    cheap on its own (~1,300 edges, well under a millisecond), but the
    topology never changes within a process's lifetime, so there's no
    reason to redo even that trivial work on every destination_times()
    call."""
    return graph().reverse(copy=True)


def destination_times(lat: float, lng: float, max_snap_m: float) -> dict[str, int] | None:
    """Real ride time from every station the live graph can reach `(lat,
    lng)` from -- the destination-side mirror of times_from_anchors(),
    computed live for one arbitrary point instead of the 4 curated
    ANCHORS.

    Snaps `(lat, lng)` to its single nearest real station, exactly like
    times_from_anchors() does for each anchor -- but returns `None`
    (never raises) when that snap exceeds `max_snap_m`, instead of
    AnchorSnapTooFar. That exception exists to catch a DATA BUG in one of
    the 4 curated, supposedly-well-served ANCHORS (see its own docstring);
    a user-typed destination carries no such guarantee, so "genuinely far
    from any station" is an honest, expected outcome here -- the caller
    (profile.commute_to_point()) turns a `None` into the same
    NO_STATION_IN_RANGE reason code the origin side already uses for the
    identical fact ("no station within range").

    Live-confirmed 2026-08-03 that this is safe to feed straight into
    profile._anchor_result()'s existing NO_RAIL_CONNECTION/
    _disconnected_stop_ids() validation with no changes there: every
    non-SIR (Staten Island Railway) station's own reverse-Dijkstra
    reachable set is IDENTICAL to the union of all 4 real ANCHORS' own
    reachable sets (checked against 12 random real stations spanning every
    borough plus PATH -- same 488-station set every time), because the
    non-SIR half of this graph is one strongly connected component. So a
    destination snapped to any real, connected station reproduces exactly
    the same reachability profile._anchor_result() already trusts, with
    no risk of a spurious UnexplainedDisconnectedStation."""
    stop_id = _nearest_station(graph(), lat, lng)
    d = _haversine_m(
        (graph().nodes[stop_id]["lat"], graph().nodes[stop_id]["lng"]), (lat, lng)
    )
    if d > max_snap_m:
        return None
    lengths = nx.single_source_dijkstra_path_length(_reverse_graph(), stop_id, weight="weight")
    return {stop: int(round(sec)) for stop, sec in lengths.items()}
