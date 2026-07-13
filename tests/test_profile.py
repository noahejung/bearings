import pytest

from bearings import profile


@pytest.fixture(scope="module")
def empire_state():
    return profile.profile_for("350 5th Ave, Manhattan")


def test_has_the_expected_top_level_shape(empire_state):
    assert {"address", "cell", "shard", "location", "transit", "amenities", "safety"} <= set(empire_state)


def test_midtown_has_a_short_commute_to_midtown(empire_state):
    assert empire_state["transit"]["to_anchors"]["midtown"] < 15


def test_midtown_is_farther_from_newport(empire_state):
    a = empire_state["transit"]["to_anchors"]
    assert a["newport_path"] > a["midtown"]


def test_finds_nearby_stations(empire_state):
    stations = empire_state["transit"]["nearest_stations"]
    assert len(stations) >= 1
    assert stations[0]["walk_minutes"] < 15
    assert stations[0]["routes"]


def test_midtown_is_dense_with_amenities(empire_state):
    a = empire_state["amenities"]
    assert a["restaurant"] > 10
    assert a["cafe"] > 3


def test_carroll_gardens_is_quieter_than_midtown(empire_state):
    """A real regression guard: the profile must actually discriminate.

    NYC GeoSearch (geocode.py) is an address-point geocoder, not an
    intersection geocoder -- "Carroll St and Smith St, Brooklyn" returns
    zero features (verified live). "360 Smith St, Brooklyn" is a real,
    resolvable address at (40.6794, -73.9958), essentially the same corner
    the intersection query was reaching for.
    """
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["amenities"]["restaurant"] < empire_state["amenities"]["restaurant"]
    assert cg["cell"] != empire_state["cell"]
