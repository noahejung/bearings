"""GTFS -> a weighted graph -> real travel times.

Every listings site tells you the distance to the subway. None of them tell
you how long it takes to get where you're actually going. The MTA publishes
the timetable; this module reads it."""

import math

import networkx as nx
import pandas as pd

from bearings import cells, config
from bearings.sources import gtfs

WALK_SPEED_MPS = 1.35        # ~4.9 km/h, a normal walking pace
TRANSFER_PENALTY_S = 240     # 4 min: walk between platforms + wait for a train
TRANSFER_MAX_M = 200.0       # stations closer than this are considered connected


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two (lat, lng) points."""
    r = 6_371_000.0
    lat1, lng1 = math.radians(a[0]), math.radians(a[1])
    lat2, lng2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _ride_times() -> pd.DataFrame:
    """Median seconds between every pair of adjacent stations, from the timetable.

    Median rather than mean: express and local trips share track, and the
    occasional pathological schedule row would drag a mean around.
    """
    st = gtfs.stop_times().sort_values(["trip_id", "seq"])

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
    g = nx.DiGraph()

    stations = gtfs.stations()
    for row in stations.itertuples():
        g.add_node(row.stop_id, name=row.name, lat=row.lat, lng=row.lng, cell=row.cell)

    # Riding edges, straight from the timetable.
    for leg in _ride_times().itertuples():
        if leg.src in g and leg.dst in g:
            g.add_edge(leg.src, leg.dst, weight=float(leg.seconds), kind="ride")

    # Transfer edges: stations close enough to walk between.
    coords = {r.stop_id: (r.lat, r.lng) for r in stations.itertuples()}
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


def times_from_anchors() -> dict[str, dict[str, int]]:
    """{anchor: {stop_id: seconds}} — the ride time from every station to each
    anchor. Run once, offline. This is the whole point of precomputation."""
    graph = build_graph()
    reverse = graph.reverse(copy=True)  # we want time *to* the anchor

    out: dict[str, dict[str, int]] = {}
    for name, (lat, lng) in config.ANCHORS.items():
        target = _nearest_station(graph, lat, lng)
        lengths = nx.single_source_dijkstra_path_length(reverse, target, weight="weight")
        out[name] = {stop: int(round(sec)) for stop, sec in lengths.items()}

    return out
