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
