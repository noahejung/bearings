import pytest
from bearings import cells, config


# Times Square, roughly.
TIMES_SQ = (40.7580, -73.9855)


def test_cell_for_returns_res9_cell():
    cell = cells.cell_for(*TIMES_SQ)
    assert isinstance(cell, str)
    # An H3 res-9 cell index always starts with '89' in its hex string form.
    assert cell.startswith("89")


def test_cell_for_is_stable():
    assert cells.cell_for(*TIMES_SQ) == cells.cell_for(*TIMES_SQ)


def test_nearby_points_share_a_cell():
    # ~10m away. A res-9 hex is ~174m edge-to-edge, so these must collide.
    a = cells.cell_for(40.7580, -73.9855)
    b = cells.cell_for(40.75809, -73.98559)
    assert a == b


def test_distant_points_do_not_share_a_cell():
    times_sq = cells.cell_for(*TIMES_SQ)
    coney = cells.cell_for(40.5755, -73.9707)
    assert times_sq != coney


def test_neighbors_includes_self_and_six_others():
    cell = cells.cell_for(*TIMES_SQ)
    ring = cells.neighbors(cell, k=1)
    assert cell in ring
    assert len(ring) == 7  # centre + 6 neighbours


def test_centroid_round_trips():
    cell = cells.cell_for(*TIMES_SQ)
    lat, lng = cells.centroid(cell)
    assert cells.cell_for(lat, lng) == cell


def test_shard_for_returns_res6_parent():
    cell = cells.cell_for(*TIMES_SQ)
    shard = cells.shard_for(cell)
    assert shard.startswith("86")  # res-6 cells start with '86'


def test_in_nyc():
    assert cells.in_nyc(*TIMES_SQ) is True
    assert cells.in_nyc(34.0522, -118.2437) is False  # Los Angeles
