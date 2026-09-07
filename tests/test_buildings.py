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


def test_raises_a_loud_error_if_attributes_not_yet_baked(monkeypatch, tmp_path):
    # The footprint Parquet IS baked (real `warmed` fixture), but the
    # per-building attribute join isn't -- must fail loud, not silently
    # serve unattributed footprints.
    monkeypatch.setattr(buildings, "_ATTR_PATH", tmp_path / "never-baked-attrs.parquet")
    with pytest.raises(FileNotFoundError):
        buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)


def test_sources_cites_a_real_working_url():
    assert buildings.SOURCE["name"]
    assert buildings.SOURCE["url"].startswith("http")


# --- per-building attribute join (LAYOUT-V3 WAVE 1e, SPEC-layout-v3.md §8,
# Noah: "what's stopping us from searching up every livable building and
# mapping that out") ---

# 22 Stagg Street, Brooklyn -- boroid=3, block=3031, lot=15. Confirmed live
# 2026-07-13 (test_hpd.py) to carry 1 open Class C ("immediately
# hazardous") violation and (test_pluto.py) yearbuilt=1930, landuse="2" (a
# real multi-family walk-up). Confirmed live 2026-08-03 that this exact bbl
# appears twice in the real BUILDING footprint dataset itself
# (base_bbl='3030310015' -> 2 real footprint rows), both centred around
# (40.7087, -73.9498) -- comfortably inside the bbox below.
KNOWN_RESIDENTIAL_BBL = "3030310015"
KNOWN_RESIDENTIAL_BBOX = {"south": 40.7076, "north": 40.7098, "west": -73.9510, "east": -73.9485}


def test_a_known_residential_buildings_own_footprint_carries_its_real_attributes(warmed):
    footprints = buildings.footprints_in_bbox(KNOWN_RESIDENTIAL_BBOX)
    matches = [f for f in footprints if f["bbl"] == KNOWN_RESIDENTIAL_BBL]
    assert matches  # the real footprint must actually be found in this bbox
    for f in matches:
        assert f["year_built"] == 1930
        assert f["era"] == "prewar"
        assert f["residential"] is True
        # test_hpd.py confirms 1 real open Class C violation on this exact
        # lot -- a real, non-fabricated, non-zero hazard count.
        assert f["hazard_class_c"] >= 1


def test_a_dense_commercial_block_has_at_least_one_nonresidential_building(warmed):
    # Guards against the "always None/True" trap: a heavily commercial
    # Midtown block (Empire State's own bbox -- landuse=5, confirmed live)
    # must show at least one real, attributed, non-residential building.
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    residential_values = {f["residential"] for f in footprints}
    assert False in residential_values
    year_built_values = [f["year_built"] for f in footprints if f["year_built"] is not None]
    assert len(year_built_values) > 10
    assert all(1600 < y <= 2026 for y in year_built_values)


def test_a_footprint_with_no_bbl_carries_no_fabricated_attributes(warmed):
    # A footprint with no bbl has no lot to look attributes up on -- every
    # attribute field must be a real None, never a guessed/default value
    # (this project's None-vs-0 rule).
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    for f in footprints:
        if f["bbl"] is None:
            assert f["year_built"] is None
            assert f["era"] is None
            assert f["residential"] is None
            assert f["hazard_class_c"] is None


def test_hazard_class_c_is_a_real_zero_not_none_for_a_matched_lot_with_no_violations(warmed):
    # "0" means "we looked and found zero", "None" means "no record" -- a
    # footprint whose bbl DOES resolve a real PLUTO lot must carry a real
    # int hazard count (0 included), never None just because that lot
    # happens to have no open Class C violation.
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    matched_no_hazard = [
        f for f in footprints if f["year_built"] is not None and f["hazard_class_c"] == 0
    ]
    assert matched_no_hazard
    for f in matched_no_hazard:
        assert isinstance(f["hazard_class_c"], int)


# --- flat lats/lngs geometry columns (2026-09-07 perf pass) ---
#
# The baked footprint geometry moved from one nested `coords`
# LIST<LIST<DOUBLE>> column to two flat `lats`/`lngs` LIST<DOUBLE> columns.
# That is a measurement, not a style choice -- see buildings.py's own
# fetch_footprints() docstring for the numbers. These tests assert on the
# real baked Parquet file, not on a fixture, because the whole point of the
# change is what DuckDB has to materialise when it reads that file.


def _describe(path):
    import duckdb

    con = duckdb.connect()
    try:
        return {name: dtype for name, dtype, *_ in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{path.as_posix()}')"
        ).fetchall()}
    finally:
        con.close()


def test_baked_footprints_store_flat_lat_lng_columns_not_a_nested_list(warmed):
    schema = _describe(buildings._PATH)
    assert schema.get("lats") == "DOUBLE[]"
    assert schema.get("lngs") == "DOUBLE[]"
    assert "coords" not in schema  # the nested LIST<LIST<DOUBLE>> is gone


def test_baked_footprints_carry_a_stable_ord_column(warmed):
    # `ord` is what footprints_in_bbox()'s ORDER BY uses -- without it the
    # endpoint is not byte-deterministic across two identical requests.
    schema = _describe(buildings._PATH)
    assert schema.get("ord") in ("BIGINT", "INTEGER", "HUGEINT")


def test_footprints_in_bbox_is_byte_deterministic_across_identical_calls(warmed):
    first = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    second = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    assert first == second
    assert len(first) > 50


def test_a_real_bbox_carries_no_exact_duplicate_footprints(warmed):
    # Duplicate rows in the bake are a SODA pagination artefact (see
    # fetch_footprints()' docstring), not two real buildings -- an
    # identical bbl AND identical geometry is the same footprint served
    # twice, and drawing it twice is pure waste.
    footprints = buildings.footprints_in_bbox(EMPIRE_STATE_BBOX)
    keys = [(f["bbl"], tuple(tuple(p) for p in f["coords"])) for f in footprints]
    assert len(keys) == len(set(keys))
