import pytest

from bearings.sources import gtfs


@pytest.fixture(scope="module")
def stations():
    return gtfs.stations()


def test_station_count_is_plausible(stations):
    # The subway has ~470 stations. Allow slack, but catch the classic
    # double-count bug (~940) and the empty-parse bug (0).
    assert 400 < len(stations) < 520


def test_stations_are_parent_stations_not_platforms(stations):
    # If we failed to collapse N/S platforms, IDs would end in N or S.
    assert not stations["stop_id"].str.endswith(("N", "S")).any()


def test_stations_have_cells(stations):
    assert stations["cell"].notna().all()


def test_times_square_serves_many_routes(stations):
    ts = stations[stations["name"].str.contains("Times Sq", case=False, na=False)]
    assert not ts.empty
    routes = set()
    for r in ts["routes"]:
        routes.update(r)
    # Times Sq-42 St is served by 1/2/3/7/N/Q/R/W/S.
    assert {"1", "2", "3", "7", "N", "Q", "R"} <= routes


# ---------------------------------------------------------------------------
# Named-station regression guards for the 2026-07-18 dedup bug.
#
# A plausible-range count check (test_station_count_is_plausible above) is
# structurally incapable of catching a single silently-dropped station --
# 496 vs. a "true" 497 is invisible to a +-60-wide band, which is exactly
# how the original bug shipped and stayed shipped. These assert specific,
# real, live-confirmed stop_ids by name instead. All three pairs below are
# real MTA stations.txt rows confirmed live 2026-07-18 to share an
# identical (stop_name, stop_lat, stop_lon) with a genuinely distinct
# sibling parent station -- see gtfs.stations()'s own docstring for the
# full mechanism. A dedup keyed on (name, lat, lon) instead of stop_id
# collapses each pair to one row and silently drops the other.
# ---------------------------------------------------------------------------


def test_queensboro_plaza_keeps_both_parent_stations(stations):
    # R09 (N/W's parent stop) and 718 (7/7X's parent stop) share the exact
    # same name and coordinates (40.750582, -73.940202) but are genuinely
    # distinct stations. Losing R09 here is what orphaned the entire
    # Astoria (N/W) line north of it from the routing graph.
    ids = set(stations["stop_id"])
    assert "R09" in ids, "Queensboro Plaza's N/W parent stop (R09) is missing"
    assert "718" in ids, "Queensboro Plaza's 7/7X parent stop (718) is missing"


def test_145_st_keeps_both_parent_stations(stations):
    # A12 (A/C's parent stop) and D13 (B/D's parent stop), both at
    # (40.824783, -73.944216) -- the same real name+coordinate collision
    # shape as Queensboro Plaza, a different line pair.
    ids = set(stations["stop_id"])
    assert "A12" in ids, "145 St's A/C parent stop (A12) is missing"
    assert "D13" in ids, "145 St's B/D parent stop (D13) is missing"


def test_w4_st_keeps_both_parent_stations(stations):
    # A32 (A/C/E's parent stop) and D20 (B/D/F/M's parent stop), both at
    # (40.732338, -74.000495) -- the third of the three real collisions
    # confirmed live in the current MTA feed.
    ids = set(stations["stop_id"])
    assert "A32" in ids, "W 4 St-Wash Sq's A/C/E parent stop (A32) is missing"
    assert "D20" in ids, "W 4 St-Wash Sq's B/D/F/M parent stop (D20) is missing"


def test_no_duplicate_stop_ids_survive_the_dedup(stations):
    # The defense-in-depth guard the dedup line is actually for: stop_id is
    # stops.txt's real primary key, so no two output rows should ever share
    # one, regardless of name/coordinate collisions.
    assert not stations["stop_id"].duplicated().any()


def test_stop_times_are_loaded():
    st = gtfs.stop_times()
    assert len(st) > 100_000
    assert {"trip_id", "stop_id", "arrival", "departure", "seq"} <= set(st.columns)


@pytest.fixture(scope="module")
def path_stations():
    return gtfs.stations(feed="path")


def test_path_has_all_13_stations(path_stations):
    # PATH has exactly 13 stations: Newark, Harrison, Journal Sq, Grove St,
    # Exchange Pl, Newport, Hoboken, WTC, and 14/23/33/9th/Christopher St.
    assert len(path_stations) == 13


def test_path_stop_ids_are_namespaced(path_stations):
    # PATH's numeric IDs (e.g. 26732) could collide with MTA's; every PATH
    # stop/station ID entering the graph must carry the PATH: prefix.
    assert path_stations["stop_id"].str.startswith("PATH:").all()


def test_path_has_newport_near_the_anchor(path_stations):
    newport = path_stations[path_stations["name"].str.contains("Newport", case=False, na=False)]
    assert not newport.empty
    row = newport.iloc[0]
    # config.ANCHORS["newport_path"] = (40.7267, -74.0339) -- essentially
    # exactly this station.
    assert abs(row["lat"] - 40.7267) < 0.01
    assert abs(row["lng"] - (-74.0339)) < 0.01


def test_path_stop_times_are_loaded():
    st = gtfs.stop_times(feed="path")
    assert len(st) > 1000
    assert st["stop_id"].str.startswith("PATH:").all()


def test_mta_stop_ids_stay_unnamespaced(stations):
    # MTA is the default feed and predates namespacing; its IDs must not
    # gain a prefix as a side effect of adding PATH support.
    assert not stations["stop_id"].str.startswith("PATH:").any()


# ---------------------------------------------------------------------------
# shapes() -- real line geometry for the map (VISUAL.md's subway layer).
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def mta_shapes():
    return gtfs.shapes()


@pytest.fixture(scope="module")
def path_shapes():
    return gtfs.shapes(feed="path")


def test_mta_shape_count_matches_raw_shape_ids(mta_shapes):
    # Confirmed live 2026-07-14: shapes.txt has 257 unique shape_ids for MTA.
    assert 200 < len(mta_shapes) < 320


def test_path_shape_count_matches_raw_shape_ids(path_shapes):
    # Confirmed live 2026-07-14: shapes.txt has 38 unique shape_ids for PATH.
    assert 20 < len(path_shapes) < 60


def test_shape_coords_are_ordered_lat_lng_pairs_inside_nyc(mta_shapes):
    row = mta_shapes.iloc[0]
    assert len(row["coords"]) > 1
    for lat, lng in row["coords"]:
        assert 40.4 < lat < 41.0
        assert -74.4 < lng < -73.6


def test_mta_shape_ids_stay_unnamespaced(mta_shapes):
    assert not mta_shapes["shape_id"].str.startswith("PATH:").any()


def test_path_shape_ids_are_namespaced(path_shapes):
    assert path_shapes["shape_id"].str.startswith("PATH:").all()


# ---------------------------------------------------------------------------
# shape_routes() -- real route labels for the map's subway line labels.
# ---------------------------------------------------------------------------


def test_mta_shapes_resolve_to_real_route_labels(mta_shapes):
    routes = gtfs.shape_routes()
    # Every real shape_id must resolve to a real, non-empty route label --
    # a broken join would silently produce "" for every shape.
    labelled = [routes.get(sid, "") for sid in mta_shapes["shape_id"]]
    assert all(labelled)
    # At least the letter/number lines riders actually navigate by must
    # show up somewhere in the label set.
    all_labels = set("/".join(labelled).split("/"))
    assert {"B", "D", "F", "M", "1", "6", "L"} <= all_labels


def test_path_shapes_resolve_to_path(path_shapes):
    routes = gtfs.shape_routes(feed="path")
    labelled = {routes.get(sid, "") for sid in path_shapes["shape_id"]}
    assert labelled == {"PATH"}


def test_shape_routes_keys_are_namespaced_like_shapes(path_shapes):
    routes = gtfs.shape_routes(feed="path")
    assert all(k.startswith("PATH:") for k in routes)
