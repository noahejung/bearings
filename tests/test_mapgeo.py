"""Tests for the map-geometry assembler (VISUAL.md's map component).

Empire State Building (350 5th Ave) is the fixture address -- it sits
directly on top of dense subway service (B/D/F/M/N/Q/R/W all within a few
hundred metres) and inside one of the noisiest 311 corridors in the city
(factcheck.py's own threshold-calibration comment cites 1,297 complaints
in a 400m radius here), so both the subway layer and the cell-density
layer have a real, non-trivial signal to assert against -- not just zeros.
"""

import pytest

from bearings import geocode, mapgeo

EMPIRE_STATE = "350 5th Ave, Manhattan"
QUIET_RIVERDALE = "3220 Netherland Ave, Bronx"


@pytest.fixture(scope="module", autouse=True)
def warmed():
    # Real bake the first time this runs in a fresh data/ directory (see
    # sources/buildings.py / sources/streets.py); a fast no-op after that.
    mapgeo.warm_caches()


@pytest.fixture(scope="module")
def loc():
    return geocode.geocode(EMPIRE_STATE)


@pytest.fixture(scope="module")
def geo(loc):
    return mapgeo.map_geometry(loc.lat, loc.lng, loc.bbl)


def test_returns_the_contract_shape(geo):
    assert set(geo) == {
        "subject",
        "bbox",
        "buildings",
        "streets",
        "subway_lines",
        "stations",
        "cells",
        "basemap_note",
        "sources",
    }
    assert set(geo["subject"]) == {"lat", "lng", "bbl", "cell"}
    assert set(geo["bbox"]) == {"south", "north", "west", "east"}


def test_finds_real_building_mass_near_a_dense_block(geo):
    assert len(geo["buildings"]) > 50
    for b in geo["buildings"]:
        assert len(b["coords"]) >= 3
        lat, lng = b["coords"][0]
        assert 40.4 < lat < 41.0
        assert -74.4 < lng < -73.6


def test_finds_real_street_hairlines_near_a_dense_block(geo):
    assert len(geo["streets"]) > 20
    for s in geo["streets"]:
        assert len(s["coords"]) >= 2
        assert s["rank"] in (0, 1, 2, 3)


def test_finds_real_subway_lines_near_a_dense_transit_address(geo):
    # 34 St-Herald Sq / 5 Av area is served by many lines -- this must not
    # come back empty for an address sitting on top of the subway.
    assert len(geo["subway_lines"]) > 0
    for line in geo["subway_lines"]:
        assert len(line["coords"]) > 1


def test_subway_line_coords_are_lat_lng_pairs(geo):
    coords = geo["subway_lines"][0]["coords"]
    lat, lng = coords[0]
    assert 40.4 < lat < 41.0
    assert -74.4 < lng < -73.6


def test_finds_real_stations_near_a_dense_transit_address(geo):
    assert len(geo["stations"]) > 0
    names = {s["name"] for s in geo["stations"]}
    assert any("Herald Sq" in n or "34 St" in n or "5 Av" in n for n in names)


def test_cells_cover_the_full_k3_disk_and_include_the_subject_cell(geo):
    # k=3 disk around one cell = 1 + 3*k*(k+1) = 37 cells.
    assert len(geo["cells"]) == 37
    h3_indices = {c["h3"] for c in geo["cells"]}
    assert geo["subject"]["cell"] in h3_indices


def test_cell_values_are_real_ints_not_none(geo):
    # Every cell was actually queried -- a real 0 is a valid value, but
    # every entry must be an int, never a missing/None placeholder.
    for c in geo["cells"]:
        assert isinstance(c["value"], int)


def test_a_dense_noisy_address_has_at_least_one_loud_cell(geo):
    # Guards against the "only ever observes zeros" trap: at least one
    # cell in this genuinely loud neighbourhood must carry a real,
    # non-trivial count -- not just structurally-present zeros everywhere.
    assert max(c["value"] for c in geo["cells"]) > 20


def test_a_quiet_address_has_real_low_or_zero_cells():
    loc = geocode.geocode(QUIET_RIVERDALE)
    geo = mapgeo.map_geometry(loc.lat, loc.lng, loc.bbl)
    # Riverdale is one of the quietest addresses this project has on
    # record (factcheck.py's calibration comment: 318 complaints in a
    # 400m radius, vs. Empire State's 1,297) -- most res-9 cells here
    # (0.105 km^2 each, much smaller than that 400m radius) should carry
    # single-digit or zero counts.
    values = [c["value"] for c in geo["cells"]]
    assert min(values) == 0 or sorted(values)[len(values) // 2] < 20


def test_basemap_note_is_present_and_does_not_claim_an_absence(geo):
    # Regression guard: the note used to say streets/buildings were absent
    # (Overture-scale limitation) -- now that both layers render, it must
    # never claim that gap still exists.
    assert geo["basemap_note"]
    assert "not rendered" not in geo["basemap_note"]
    assert "absent" not in geo["basemap_note"]


def test_sources_cite_real_working_urls(geo):
    for source in geo["sources"].values():
        assert source["name"]
        assert source["url"].startswith("http")
