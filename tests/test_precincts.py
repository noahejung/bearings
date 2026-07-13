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
