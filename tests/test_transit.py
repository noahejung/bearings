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
