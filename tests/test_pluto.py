import pytest

from bearings.sources import pluto

# 22 Stagg Street, Brooklyn -- same building as the HPD fixture. Confirmed
# live 2026-07-13: yearbuilt=1930.
KNOWN_BBL = "3030310015"

# 350 5th Ave, Manhattan (the Empire State Building). Confirmed live
# 2026-07-13: yearbuilt=1931. Also the address the profile test suite uses.
EMPIRE_STATE_BBL = "1008350041"

# A real Bronx lot (761 Clarence Ave area, next-door parcel) whose PLUTO
# record carries yearbuilt=0 -- PLUTO's documented "not recorded" sentinel.
# Confirmed live.
UNKNOWN_YEAR_BBL = "2054810079"

# No lot exists at this BBL.
NO_SUCH_BBL = "9999999999"


def test_known_building_year_and_era():
    b = pluto.building(KNOWN_BBL)
    assert b["year_built"] == 1930
    assert b["era"] == "prewar"


def test_empire_state_building_is_prewar():
    b = pluto.building(EMPIRE_STATE_BBL)
    assert b["year_built"] == 1931
    assert b["era"] == "prewar"


def test_yearbuilt_zero_maps_to_none_never_to_a_year():
    b = pluto.building(UNKNOWN_YEAR_BBL)
    assert b["year_built"] is None
    assert b["era"] is None


def test_unknown_bbl_returns_none():
    b = pluto.building(NO_SUCH_BBL)
    assert b["year_built"] is None
    assert b["era"] is None


@pytest.mark.parametrize(
    "year,expected",
    [
        (1899, "prewar"),
        (1939, "prewar"),
        (1940, "postwar"),
        (1999, "postwar"),
        (2000, "modern"),
        (2026, "modern"),
    ],
)
def test_era_boundaries(year, expected):
    assert pluto._era(year) == expected


def test_exposes_its_source():
    assert pluto.SOURCE["name"] == "NYC PLUTO"
    assert "64uk-42ks" in pluto.SOURCE["url"]
