import pytest

from bearings.sources import precincts


def test_carroll_gardens_is_the_76th():
    # Carroll St & Smith St, Brooklyn.
    assert precincts.precinct_for(40.6795, -73.9955) == 76


def test_bushwick_is_the_83rd():
    # Myrtle-Wyckoff, roughly.
    assert precincts.precinct_for(40.6996, -73.9119) == 83


def test_outside_nyc_is_none():
    assert precincts.precinct_for(34.0522, -118.2437) is None


def test_all_precinct_numbers_returns_the_real_78():
    numbers = precincts.all_precinct_numbers()
    assert len(numbers) == 78
    assert 76 in numbers  # Carroll Gardens
    assert 22 in numbers  # Central Park -- see module docstring
    assert len(numbers) == len(set(numbers))  # no dupes


def test_precinct_features_returns_real_simplified_geometry():
    features = precincts.precinct_features()
    assert len(features) == 78
    by_precinct = {f["precinct"]: f for f in features}
    p76 = by_precinct[76]
    assert 40.4 < p76["lat"] < 41.0
    assert -74.4 < p76["lng"] < -73.6
    assert p76["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert len(p76["geometry"]["coordinates"]) > 0


def test_simplification_actually_shrinks_the_payload():
    # Regression guard for the 3.83MB -> 243KB simplification this module's
    # docstring cites -- a no-op simplify() call (tolerance=0) would still
    # pass every other assertion here while silently shipping the full
    # 3.83MB citywide payload on every map load.
    import json

    full = precincts.precinct_features(simplify_tolerance_deg=0.0)
    simplified = precincts.precinct_features()
    full_size = len(json.dumps([f["geometry"] for f in full]))
    simplified_size = len(json.dumps([f["geometry"] for f in simplified]))
    assert simplified_size < full_size * 0.5
