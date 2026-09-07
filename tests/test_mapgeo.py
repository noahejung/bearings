"""Tests for the map-geometry assembler (VISUAL.md's map component).

Empire State Building (350 5th Ave) is the fixture address -- it sits
directly on top of dense subway service (B/D/F/M/N/Q/R/W all within a few
hundred metres) and dense enough that the building-footprint and street
layers have a real, non-trivial signal to assert against -- not just
zeros. (It was also chosen for a per-cell 311 noise layer this endpoint
carried until 2026-09-07; see the removal note further down.)
"""

import pytest

from bearings import geocode, mapgeo, profile

EMPIRE_STATE = "350 5th Ave, Manhattan"


@pytest.fixture(scope="module", autouse=True)
def warmed():
    # Real bake the first time this runs in a fresh data/ directory (see
    # sources/buildings.py / sources/streets.py); a fast no-op after that.
    # profile.warm_caches() bakes data/derived/pois.parquet, which
    # mapgeo._amenity_cell_counts() reads directly -- mirrors api.py's own
    # lifespan startup order (profile.warm_caches() runs before
    # mapgeo.warm_caches() there too), not a new dependency.
    profile.warm_caches()
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


def test_buildings_carry_real_per_building_attributes(geo):
    # LAYOUT-V3 WAVE 1e: every building footprint the map serves now carries
    # its own real PLUTO/HPD attributes, end to end through map_geometry()
    # -- not just at the buildings.py source-module level (test_buildings.py
    # covers that directly against a known fixture).
    for b in geo["buildings"]:
        assert set(b) == {"bbl", "coords", "year_built", "era", "residential", "hazard_class_c"}
    with_year = [b for b in geo["buildings"] if b["year_built"] is not None]
    assert len(with_year) > 10  # a real, non-trivial signal, not just structurally-present Nones
    for b in with_year:
        assert 1600 < b["year_built"] <= 2026
        assert b["era"] in ("prewar", "postwar", "modern")
        assert isinstance(b["hazard_class_c"], int)
    # Dense Midtown commercial blocks must show at least one real
    # non-residential building -- guards the same "always None/True" trap
    # test_buildings.py's own equivalent test guards.
    assert False in {b["residential"] for b in geo["buildings"]}


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


def test_subway_lines_carry_a_real_route_label(geo):
    # Every line drawn near a dense transit address must resolve to a real
    # rider-facing route label, never a blank string (VISUAL.md: subway
    # lines are "labelled by route").
    assert all(line["route"] for line in geo["subway_lines"])
    all_labels = set("/".join(line["route"] for line in geo["subway_lines"]).split("/"))
    assert {"B", "D", "F", "M"} & all_labels


def test_subway_lines_carry_a_real_shape_id(geo):
    # WAVE 4 (SPEC-layout-v3.md Wave 4): the route-line preview's join key --
    # GET /api/route returns the real shape_id(s) a computed commute rode,
    # and the frontend filters this already-loaded array by shape_id rather
    # than fetching geometry a second time. Must be present and non-blank
    # on every line, same bar as the route label above.
    assert all(line["shape_id"] for line in geo["subway_lines"])


def test_finds_real_stations_near_a_dense_transit_address(geo):
    assert len(geo["stations"]) > 0
    names = {s["name"] for s in geo["stations"]}
    assert any("Herald Sq" in n or "34 St" in n or "5 Av" in n for n in names)


def test_stations_carry_their_real_served_routes(geo):
    herald = next(s for s in geo["stations"] if "Herald Sq" in s["name"])
    assert set(herald["routes"]) >= {"B", "D", "F", "M"}


# ---------------------------------------------------------------------------
# The per-cell metric block that used to live here is gone (2026-09-07).
#
# map_geometry() used to return a `cells` array: five metrics
# (noise/amenities/trees/building_age_years/transit_access) for all 37
# cells of a k=3 disk, which cost three live, uncached Socrata round trips
# on every single GET /api/map request. Nothing rendered it. A repo-wide
# grep on 2026-09-07 -- web/src including *.test.tsx, web/src/types.ts,
# the Python tests, README.md, Dockerfile, render.yaml -- found no reader
# of `geo.cells` anywhere; the only remaining consumers were these tests
# and a fixture. The five numbers the map DOES render come from
# GET /api/cells (cellprofile.cells_index(), a baked flat-file read),
# which carries the identical five metrics for every real cell citywide,
# not just the 37 in one address's disk. So this was duplicated compute,
# on the request path, feeding nothing.
#
# Coverage did not disappear with it: cellprofile.py computes the same
# five metrics at bake time and tests/test_cellprofile.py asserts on them
# (including the same "not just zeros" and "None means no record" guards
# these tests carried). What is asserted here now is the negative -- that
# the endpoint no longer ships the field and no longer makes the calls.
# ---------------------------------------------------------------------------


def test_map_geometry_no_longer_returns_a_cells_field(geo):
    assert "cells" not in geo


def test_map_geometry_makes_no_live_socrata_call(loc, monkeypatch):
    """The point of the removal: /api/map must be pure local compute over
    baked files. socrata.fetch() is the single chokepoint all three of the
    old live calls (311 noise, street trees, PLUTO building age) went
    through, so making it explode proves none of them is left."""

    def explode(*_a, **_kw):
        raise AssertionError(
            "map_geometry() made a live Socrata call -- /api/map is supposed "
            "to read only baked files now"
        )

    monkeypatch.setattr("bearings.sources.socrata.fetch", explode)
    geo = mapgeo.map_geometry(loc.lat, loc.lng, loc.bbl)
    # and it still returns the real layers, not an empty husk
    assert len(geo["buildings"]) > 50
    assert len(geo["streets"]) > 10
    assert len(geo["subway_lines"]) > 0
    assert len(geo["stations"]) > 0


def test_sources_no_longer_cite_data_the_response_does_not_carry(geo):
    """A citation for a number that is not in the payload is the mirror of
    this project's own "a number with no citation is a bug" rule. The 311
    noise / Overture amenity / street-tree / transit-access citations went
    with the `cells` field they described."""
    assert set(geo["sources"]) == {
        "basemap",
        "subway",
        "buildings",
        "streets",
        "building_age",
        "hazards",
    }


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
