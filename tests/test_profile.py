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


def test_safety_is_populated(empire_state):
    s = empire_state["safety"]
    assert s["precinct"] > 0
    assert s["total_ytd"] > 0


def test_carroll_gardens_lands_in_the_76th():
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["safety"]["precinct"] == 76


def test_safety_carries_a_citywide_crime_percentile(empire_state):
    # Precinct 14 (Midtown South, Empire State's own precinct) is a
    # genuinely high-crime-volume precinct -- live-verified 2026-07-15
    # against the real citywide distribution (see test_citywide.py's own
    # discriminating regression guard for the exact numbers). Crime is now
    # relative-to-NYC (VISUAL.md §5), never an absolute count on its own.
    s = empire_state["safety"]
    assert isinstance(s["crime_percentile"], float)
    assert s["crime_percentile"] > 90


def test_carroll_gardens_reads_as_lower_crime_than_empire_state(empire_state):
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["safety"]["crime_percentile"] < empire_state["safety"]["crime_percentile"]
    assert cg["safety"]["crime_percentile"] < 10


def test_has_the_new_blocks(empire_state):
    assert {"quiet", "green", "building"} <= set(empire_state)


def test_quiet_block_shape(empire_state):
    q = empire_state["quiet"]
    assert isinstance(q["noise_complaints_12mo"], int)
    assert q["noise_complaints_12mo"] > 0
    assert q["source"] == {
        "name": "NYC 311",
        "url": "https://data.cityofnewyork.us/d/erm2-nwe9",
    }


def test_green_block_shape(empire_state):
    g = empire_state["green"]
    assert isinstance(g["street_trees_nearby"], int)
    assert g["source"] == {
        "name": "NYC Street Tree Census",
        "url": "https://data.cityofnewyork.us/d/uvpi-gqnh",
    }


def test_building_block_for_empire_state(empire_state):
    b = empire_state["building"]
    assert b["year_built"] == 1931
    assert b["era"] == "prewar"
    assert "rent-stabilised" in b["era_note"]
    assert b["hpd_open_violations"]["class_c"] >= 0
    assert b["source"] == {
        "name": "NYC PLUTO + HPD",
        "url": "https://data.cityofnewyork.us/d/wvxf-dwi5",
    }


def test_building_year_built_is_never_a_bare_zero(empire_state):
    # PLUTO's yearbuilt=0 "not recorded" sentinel must never leak through
    # as a literal year -- it has to become None.
    assert empire_state["building"]["year_built"] != 0
