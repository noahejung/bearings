"""Tests for reach.py -- the 5/10/15-minute walk-ring feature
(SPEC-lens-report.md §3). Empire State Building (350 5th Ave, Manhattan) is
this repo's own standard dense fixture (test_mapgeo.py, test_api.py) -- it
sits on top of dense subway service and a dense daily-life-places corridor,
so both places_near and stations_near have real, non-trivial signal to
assert against, not just structural zeros.
"""

import pytest

from bearings import geocode, profile, reach
from bearings.transit import WALK_SPEED_MPS, _haversine_m

EMPIRE_STATE = "350 5th Ave, Manhattan"


@pytest.fixture(scope="module", autouse=True)
def warmed():
    # profile.warm_caches() bakes data/derived/pois.parquet, which
    # reach._places_near() reads directly -- same dependency mapgeo.py's
    # own amenity metric has, same warm-up order api.py's lifespan uses.
    profile.warm_caches()


@pytest.fixture(scope="module")
def loc():
    return geocode.geocode(EMPIRE_STATE)


def test_band_radius_is_exactly_walk_speed_times_minutes():
    for minutes in reach.REACH_BANDS_MINUTES:
        assert reach.band_radius_m(minutes) == WALK_SPEED_MPS * minutes * 60.0
    assert reach.band_radius_m(5) == pytest.approx(405.0)
    assert reach.band_radius_m(10) == pytest.approx(810.0)
    assert reach.band_radius_m(15) == pytest.approx(1215.0)


def test_band_radii_are_strictly_increasing():
    radii = [reach.band_radius_m(m) for m in reach.REACH_BANDS_MINUTES]
    assert radii == sorted(radii)
    assert len(set(radii)) == len(radii)


def test_ring_polygon_vertices_are_all_the_real_radius_from_center(loc):
    # A real geodesic check, not just "returns something the right shape":
    # every sampled vertex must be within a tight tolerance of radius_m from
    # (lat, lng) via the same haversine distance the rest of this codebase
    # uses -- proves the longitude correction actually worked at this real
    # NYC latitude, not just at the equator.
    radius_m = 810.0
    ring = reach._ring_polygon(loc.lat, loc.lng, radius_m, n=64)
    assert len(ring) == 65  # n + 1, closed ring
    assert ring[0] == ring[-1]
    for lat, lng in ring:
        d = _haversine_m((loc.lat, loc.lng), (lat, lng))
        assert d == pytest.approx(radius_m, rel=0.01)


def test_band_for_assigns_the_smallest_covering_band():
    assert reach._band_for(0.0) == 5
    assert reach._band_for(404.0) == 5
    assert reach._band_for(406.0) == 10
    assert reach._band_for(809.0) == 10
    assert reach._band_for(811.0) == 15
    assert reach._band_for(1214.0) == 15
    assert reach._band_for(1216.0) is None  # beyond every real band


def test_places_near_a_dense_address_has_real_nontrivial_hits(loc):
    places = reach._places_near(loc.lat, loc.lng, reach.band_radius_m(15))
    assert len(places) > 20
    categories = {p["category"] for p in places}
    # Real signal in at least the categories this dense Midtown block is
    # known (test_mapgeo.py's own comment) to be dense with.
    assert "cafe" in categories
    assert "bar" in categories
    for p in places:
        assert p["name"]
        assert p["band_minutes"] in reach.REACH_BANDS_MINUTES
        d = _haversine_m((loc.lat, loc.lng), (p["lat"], p["lng"]))
        assert d <= reach.band_radius_m(p["band_minutes"])
        # Never assigned a band SMALLER than its real distance covers.
        prior_bands = [m for m in reach.REACH_BANDS_MINUTES if m < p["band_minutes"]]
        if prior_bands:
            assert d > reach.band_radius_m(max(prior_bands))


def test_places_near_excludes_places_outside_the_max_band(loc):
    max_radius = reach.band_radius_m(15)
    places = reach._places_near(loc.lat, loc.lng, max_radius)
    for p in places:
        d = _haversine_m((loc.lat, loc.lng), (p["lat"], p["lng"]))
        assert d <= max_radius


def test_stations_near_a_dense_transit_address_finds_real_named_stations(loc):
    stations = reach._stations_near(loc.lat, loc.lng, reach.band_radius_m(15))
    assert len(stations) > 0
    names = {s["name"] for s in stations}
    assert any("Herald Sq" in n or "34 St" in n for n in names)
    for s in stations:
        assert s["routes"]
        assert s["band_minutes"] in reach.REACH_BANDS_MINUTES


def test_reach_returns_the_full_contract_shape(loc):
    result = reach.reach(EMPIRE_STATE)
    assert set(result) == {"center", "bands", "places", "stations", "method_note", "sources"}
    assert result["center"] == {"lat": loc.lat, "lng": loc.lng}
    assert len(result["bands"]) == 3
    for band in result["bands"]:
        assert set(band) == {"minutes", "radius_m", "polygon"}
        assert band["minutes"] in reach.REACH_BANDS_MINUTES
        assert len(band["polygon"]) > 3
    assert "roughly" in result["method_note"].lower()
    assert "straight line" in result["method_note"].lower()
    assert set(result["sources"]) == {"places", "stations"}
    for source in result["sources"].values():
        assert source["name"]
        assert source["url"].startswith("http")


def test_reach_bad_address_raises_geocode_error():
    with pytest.raises(geocode.GeocodeError):
        reach.reach("qqqqqqqqzzzzzzz not a real place")


def test_reach_is_deterministic_for_a_fixed_center():
    # Two calls at the same real point must produce identical geometry --
    # no hidden randomness in the ring construction.
    a = reach._bands(40.748441, -73.985656)
    b = reach._bands(40.748441, -73.985656)
    assert a == b
