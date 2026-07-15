"""Tests for the building-footprint source module (VISUAL.md's map "mass"
layer). Empire State Building's block (Herald Sq area, Manhattan) is the
fixture: dense enough that a 700m bbox around it is guaranteed to contain
real building footprints, not just structurally-empty results.

The first test run in a fresh data/ directory pays the real bake cost
(~1.08M footprints paginated over Socrata, ~3.5 minutes -- see
buildings.py's module docstring); every run after that loads the already-baked
Parquet file from disk in milliseconds, matching every other disk-cached
source in this codebase (profile.py's POI table, sources/gtfs.py's zips).
"""

import pytest

from bearings.sources import buildings

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


@pytest.fixture(scope="module")
def warmed():
    buildings.warm_cache()


def test_finds_real_buildings_near_a_dense_block(warmed):
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    assert len(footprints) > 50  # a real Midtown block, not a handful of stragglers
    for f in footprints:
        assert len(f["coords"]) >= 3
        lat, lng = f["coords"][0]
        assert 40.4 < lat < 41.0
        assert -74.4 < lng < -73.6


def test_a_real_share_of_footprints_carry_a_bbl(warmed):
    # Not every footprint resolves a BBL (accessory structures, some
    # unassigned lots) -- but on a real NYC block the large majority
    # should, so this guards against a join that silently always fails.
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    with_bbl = [f for f in footprints if f["bbl"]]
    assert len(with_bbl) / len(footprints) > 0.5
    for f in with_bbl:
        assert len(f["bbl"]) == 10  # boro(1) + block(5) + lot(4)


def test_far_outside_nyc_returns_empty_not_an_error(warmed):
    assert buildings.footprints_in_bbox(FAR_FROM_NYC_BBOX) == []


def test_raises_a_loud_error_if_not_yet_baked(monkeypatch, tmp_path):
    monkeypatch.setattr(buildings, "_PATH", tmp_path / "never-baked.parquet")
    with pytest.raises(FileNotFoundError):
        buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)


def test_sources_cites_a_real_working_url():
    assert buildings.SOURCE["name"]
    assert buildings.SOURCE["url"].startswith("http")
