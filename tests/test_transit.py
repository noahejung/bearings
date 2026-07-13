import pytest

from bearings import transit


@pytest.fixture(scope="module")
def graph():
    return transit.build_graph()


@pytest.fixture(scope="module")
def times():
    return transit.times_from_anchors()


def test_graph_has_all_stations(graph):
    assert 400 < graph.number_of_nodes() < 520


def test_graph_has_edges(graph):
    assert graph.number_of_edges() > 800


def test_adjacent_stops_are_a_couple_of_minutes_apart(graph):
    # Every ride between adjacent stations should be between 30s and 10min.
    weights = [d["weight"] for _, _, d in graph.edges(data=True)]
    typical = sorted(weights)[len(weights) // 2]
    assert 30 <= typical <= 600


def test_every_anchor_is_reachable(times):
    for anchor in transit.config.ANCHORS:
        assert anchor in times
        assert len(times[anchor]) > 300  # most of the system reaches each anchor


def test_times_to_midtown_are_plausible(times):
    midtown = times["midtown"]
    # No trip within the subway system should take more than ~2.5 hours.
    assert max(midtown.values()) < 9000
    # And something must be very close to the anchor itself.
    assert min(midtown.values()) < 300


def test_every_anchor_snaps_to_a_station_that_is_actually_there():
    """A 2.4km snap silently produced Times Sq -> Newport = 8.5 min. Never again."""
    graph = transit.build_graph()
    for name, (lat, lng) in transit.config.ANCHORS.items():
        stop = transit._nearest_station(graph, lat, lng)
        d = transit._haversine_m(
            (graph.nodes[stop]["lat"], graph.nodes[stop]["lng"]), (lat, lng)
        )
        assert d <= transit.MAX_ANCHOR_SNAP_M, (
            f"anchor {name!r} snapped to {graph.nodes[stop]['name']!r} "
            f"{d:.0f}m away - the network serving it is missing from the graph"
        )


def test_path_stations_are_in_the_graph(graph):
    path_nodes = [n for n in graph.nodes if n.startswith("PATH:")]
    assert len(path_nodes) == 13


def test_path_and_subway_wtc_are_transfer_connected(graph):
    """PATH's WTC (~40.71271, -74.01193) sits close enough to the subway's
    WTC/Cortlandt cluster that the existing 200m haversine transfer rule
    should connect the two networks without any special-casing."""
    path_wtc = [
        n
        for n, d in graph.nodes(data=True)
        if n.startswith("PATH:") and "world trade center" in d["name"].lower()
    ]
    assert path_wtc, "PATH World Trade Center station not found in graph"
    p = path_wtc[0]

    subway_neighbors_within_transfer_range = [
        (n, d["kind"])
        for n, d in graph[p].items()
        if not n.startswith("PATH:") and d["kind"] == "transfer"
    ]
    assert subway_neighbors_within_transfer_range, (
        "no subway station transfer-connected to PATH WTC -- "
        "the cross-network edge did not form"
    )


def test_farther_stations_take_longer(times):
    """Sanity: Coney Island must be farther from Midtown than Union Sq."""
    from bearings.sources import gtfs

    st = gtfs.stations()

    def stop_id_for(name_fragment: str) -> str:
        hit = st[st["name"].str.contains(name_fragment, case=False, na=False)]
        assert not hit.empty, f"no station matching {name_fragment!r}"
        return hit.iloc[0]["stop_id"]

    midtown = times["midtown"]
    union_sq = midtown[stop_id_for("14 St-Union Sq")]
    coney = midtown[stop_id_for("Coney Island")]

    assert coney > union_sq
    assert union_sq < 900        # Union Sq is <15 min from Times Sq
    assert 1800 < coney < 5400   # Coney Island is a 30-90 min haul
