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


# ---------------------------------------------------------------------------
# Named-station regression guards for the 2026-07-18 dedup bug (see
# test_gtfs.py's own block of these for the full mechanism). A +-60-wide
# node-count band (test_graph_has_all_stations above) cannot detect one
# missing node; these assert a specific real station and a specific real
# edge instead.
# ---------------------------------------------------------------------------


def test_queensboro_plaza_nw_parent_is_a_graph_node(graph):
    # R09 -- the N/W line's own parent stop at Queensboro Plaza -- was
    # silently dropped by the old (name, lat, lon) dedup because it shares
    # coordinates with 718 (the 7/7X's parent stop). Both must be nodes.
    assert "R09" in graph, "Queensboro Plaza's N/W parent stop (R09) is not a graph node"
    assert "718" in graph, "Queensboro Plaza's 7/7X parent stop (718) is not a graph node"


def test_astoria_ride_edge_into_queensboro_plaza_exists(graph):
    # A real, scheduled N-train edge (confirmed live against stop_times.txt
    # 2026-07-18: trip BSP26GEN-N058-Saturday-00_001050_N..S20R runs
    # ...R06 -> R08 -> R09... as part of its real sequence). This edge only
    # exists if R09 survived the dedup as a graph node -- build_graph()'s
    # edge guard (`if leg.src in g and leg.dst in g`) silently drops any
    # ride edge whose endpoint isn't a node, with no error.
    assert graph.has_edge("R08", "R09"), (
        "R08 (39 Av-Dutch Kills) -> R09 (Queensboro Plaza) ride edge is missing -- "
        "the real N-train edge exists in the timetable but was dropped at "
        "graph-build time because R09 was not registered as a node"
    )


def test_all_six_orphaned_astoria_stations_are_reachable_from_an_anchor(times):
    # The full set of real, currently-running N/W stations the 2026-07-18
    # dedup bug orphaned from the graph (Ditmars Blvd through 39 Av-Dutch
    # Kills, north of the Queensboro Plaza collision). Every one must be
    # reachable from at least one of the four commute anchors -- this is
    # the actual outcome that matters (a rider can get a real commute time
    # from any of these), not just "the node exists."
    astoria_ids = {
        "R01": "Astoria-Ditmars Blvd",
        "R03": "Astoria Blvd",
        "R04": "30 Av",
        "R05": "Broadway",
        "R06": "36 Av",
        "R08": "39 Av-Dutch Kills",
    }
    for stop_id, name in astoria_ids.items():
        reachable = any(stop_id in by_stop for by_stop in times.values())
        assert reachable, f"{name} ({stop_id}) is unreachable from every anchor"


# ---------------------------------------------------------------------------
# LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A): the live routable
# graph singleton and destination_times() -- the destination-side mirror of
# times_from_anchors(), for one arbitrary point instead of the 4 curated
# ANCHORS.
# ---------------------------------------------------------------------------


def test_graph_is_memoised_across_calls():
    a = transit.graph()
    b = transit.graph()
    assert a is b


def test_destination_times_reaches_the_full_network_from_a_real_station():
    # 14 St-Union Sq (R20) -- a real, exact station point (0m snap), so
    # by_stop must cover the same reachable set every one of the 4 real
    # ANCHORS already does (test_every_anchor_is_reachable above) --
    # confirmed live 2026-08-03 that the non-SIR half of this graph is one
    # strongly connected component, so ANY real non-SIR station's own
    # reverse-Dijkstra reach is the identical set.
    lat, lng = 40.734789, -73.990568
    by_stop = transit.destination_times(lat, lng, transit.MAX_ANCHOR_SNAP_M)
    assert by_stop is not None
    assert len(by_stop) > 300


def test_destination_times_none_when_nothing_within_the_snap_radius():
    # Open ocean well off Rockaway (the same fixture point test_api.py's
    # own test_cell_unknown_h3_is_404_not_500 uses for "no real cell here")
    # -- the real nearest station is >21km away (confirmed live), so a
    # generous 1200m snap radius still finds nothing.
    by_stop = transit.destination_times(40.40, -73.75, 1200.0)
    assert by_stop is None


# ---------------------------------------------------------------------------
# WAVE 4 (SPEC-layout-v3.md Wave 4): route-line preview + nav directions --
# single-pair path reconstruction (`nearest_stop()`/`path_between()`), the
# on-demand complement to the bulk single-source sweeps above.
# ---------------------------------------------------------------------------


def test_nearest_stop_matches_the_internal_snap(graph):
    lat, lng = transit.config.ANCHORS["midtown"]
    assert transit.nearest_stop(lat, lng) == transit._nearest_station(graph, lat, lng)


def test_path_between_same_stop_is_a_real_but_empty_path():
    stop = transit.nearest_stop(*transit.config.ANCHORS["midtown"])
    assert transit.path_between(stop, stop) == []


def test_path_between_a_real_reachable_pair_has_only_real_edge_kinds():
    origin = transit.nearest_stop(40.734789, -73.990568)  # 14 St-Union Sq
    dest = transit.nearest_stop(*transit.config.ANCHORS["downtown_brooklyn"])
    hops = transit.path_between(origin, dest)
    assert hops
    assert all(h["kind"] in ("ride", "transfer") for h in hops)
    assert all(h["seconds"] > 0 for h in hops)
    # Hops must actually chain: each hop's "to" is the next hop's "from".
    for a, b in zip(hops, hops[1:]):
        assert a["to"] == b["from"]


def test_path_between_none_across_disconnected_components(graph):
    # Any real SIR station has no path to the rest of the network at all
    # (test_profile.py's own _disconnected_stop_ids() proves this set is
    # exactly Staten Island Railway) -- path_between() must say so honestly
    # rather than raising or fabricating a route.
    sir = next(
        n for n, d in graph.nodes(data=True) if "st george" in d["name"].lower()
    )
    midtown_stop = transit.nearest_stop(*transit.config.ANCHORS["midtown"])
    assert transit.path_between(sir, midtown_stop) is None


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
