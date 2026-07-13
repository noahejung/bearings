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
