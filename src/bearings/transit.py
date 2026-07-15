"""GTFS -> a weighted graph -> real travel times.

Every listings site tells you the distance to the subway. None of them tell
you how long it takes to get where you're actually going. The MTA publishes
the timetable; this module reads it."""

import math

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
    "In-vehicle time plus a nominal transfer penalty. Excludes the walk "
    "from your door and the wait on the platform. Treat as a floor, not "
    "a door-to-door estimate."
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
