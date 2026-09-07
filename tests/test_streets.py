"""Tests for the street-centreline source module (VISUAL.md's map "ink
hairline" layer, weighted by road class). Empire State Building's block
(Herald Sq area, Manhattan) is the fixture for the bbox tests -- dense
enough to guarantee real segments, not structurally-empty results.

The rank tests use physicalid 179271 (WFC-Wall Street Ferry Route,
confirmed live 2026-07-14 via `full_street_name like 'WFC-WALL%'`) as a
real, on-record ferry segment that must never render as a street, and the
module docstring's own live-confirmed rw_type='2' highway examples (Henry
Hudson Pkwy, Major Deegan Expy, etc.) to ground `_rank()`'s pure logic.
"""

import pytest

from bearings.sources import streets

EMPIRE_STATE_BBOX = {
    "south": 40.7421,
    "north": 40.7547,
    "west": -73.9957,
    "east": -73.9757,
}

FAR_FROM_NYC_BBOX = {
    "south": 34.0,
    "north": 34.1,
    "west": -118.3,
    "east": -118.2,
}

# Covers physicalid 179271's real geometry (WFC-Wall Street Ferry Route),
# confirmed live 2026-07-14: coordinates run roughly (40.7146, -74.0195) to
# (40.7150, -74.0180).
WFC_FERRY_BBOX = {
    "south": 40.712,
    "north": 40.717,
    "west": -74.022,
    "east": -74.016,
}
WFC_FERRY_PHYSICALID = "179271"


@pytest.fixture(scope="module")
def warmed():
    streets.warm_cache()


def test_finds_real_streets_near_a_dense_block(warmed):
    segments = streets.segments_in_bbox(EMPIRE_STATE_BBOX)
    assert len(segments) > 20
    for s in segments:
        assert len(s["coords"]) >= 2
        assert s["rank"] in (0, 1, 2, 3)
        lat, lng = s["coords"][0]
        assert 40.4 < lat < 41.0
        assert -74.4 < lng < -73.6


def test_ferry_routes_are_never_rendered_as_streets(warmed):
    # Real, on-record ferry segment (a water route, not pavement) --
    # excluded at fetch time (see module docstring). Its own bbox must
    # come back with no trace of it.
    segments = streets.segments_in_bbox(WFC_FERRY_BBOX)
    physicalids = {s["physicalid"] for s in segments}
    assert WFC_FERRY_PHYSICALID not in physicalids


def test_far_outside_nyc_returns_empty_not_an_error(warmed):
    assert streets.segments_in_bbox(FAR_FROM_NYC_BBOX) == []


def test_raises_a_loud_error_if_not_yet_baked(monkeypatch, tmp_path):
    monkeypatch.setattr(streets, "_PATH", tmp_path / "never-baked.parquet")
    with pytest.raises(FileNotFoundError):
        streets.segments_in_bbox(EMPIRE_STATE_BBOX)


def test_rank_highway_takes_priority_over_lane_count():
    # rw_type='2' confirmed live against real highway segments -- see
    # module docstring. A 2-lane highway still ranks as a highway, not a
    # local street.
    assert streets._rank("2", 2.0) == streets.RANK_HIGHWAY


def test_rank_scales_with_lane_count_for_non_highways():
    assert streets._rank(None, 6.0) == streets.RANK_ARTERIAL
    assert streets._rank("1", 4.0) == streets.RANK_COLLECTOR
    assert streets._rank("1", 1.0) == streets.RANK_LOCAL
    assert streets._rank("10", 0.0) == streets.RANK_LOCAL


def test_sources_cites_a_real_working_url():
    assert streets.SOURCE["name"]
    assert streets.SOURCE["url"].startswith("http")


# --- flat lats/lngs geometry columns (2026-09-07 perf pass) ---
# Same change, same reasoning as tests/test_buildings.py's own block --
# see sources/buildings.py's fetch_footprints() docstring for the measured
# reason the nested column had to go.


def _describe(path):
    import duckdb

    con = duckdb.connect()
    try:
        return {name: dtype for name, dtype, *_ in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{path.as_posix()}')"
        ).fetchall()}
    finally:
        con.close()


def test_baked_segments_store_flat_lat_lng_columns_not_a_nested_list(warmed):
    schema = _describe(streets._PATH)
    assert schema.get("lats") == "DOUBLE[]"
    assert schema.get("lngs") == "DOUBLE[]"
    assert "coords" not in schema


def test_baked_segments_carry_a_stable_ord_column(warmed):
    schema = _describe(streets._PATH)
    assert schema.get("ord") in ("BIGINT", "INTEGER", "HUGEINT")


def test_segments_in_bbox_is_byte_deterministic_across_identical_calls(warmed):
    first = streets.segments_in_bbox(EMPIRE_STATE_BBOX)
    second = streets.segments_in_bbox(EMPIRE_STATE_BBOX)
    assert first == second
    assert len(first) > 20


def test_a_real_bbox_carries_no_exact_duplicate_segments(warmed):
    segments = streets.segments_in_bbox(EMPIRE_STATE_BBOX)
    keys = [(s["physicalid"], tuple(tuple(p) for p in s["coords"])) for s in segments]
    assert len(keys) == len(set(keys))
