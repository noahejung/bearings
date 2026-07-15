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


# --- points_in_bbox() -- per-cell building-age metric (mapgeo.py) ---

# A real ~700m half-width box around the Empire State Building, matching
# mapgeo.py's own BBOX_RADIUS_M -- confirmed live 2026-07-15: >2,000 PLUTO
# lots with a recorded yearbuilt inside a slightly larger box, so this
# smaller one is still a real, non-trivial signal.
ESB_BBOX = {"south": 40.7421, "north": 40.7547, "west": -73.9957, "east": -73.9757}

# Open water south of Staten Island -- no lot, no yearbuilt.
WATER_BBOX = {"south": 40.445, "north": 40.455, "west": -74.055, "east": -74.045}


def test_points_in_bbox_returns_real_nontrivial_points_with_plausible_years():
    df = pluto.points_in_bbox(ESB_BBOX)
    assert len(df) > 500
    assert set(df.columns) == {"lat", "lng", "year_built"}
    for lat, lng, year in zip(df["lat"], df["lng"], df["year_built"]):
        assert ESB_BBOX["south"] < lat < ESB_BBOX["north"]
        assert ESB_BBOX["west"] < lng < ESB_BBOX["east"]
        assert 1600 < year <= 2026  # never the yearbuilt=0 sentinel


def test_points_in_bbox_never_returns_the_zero_sentinel_year():
    df = pluto.points_in_bbox(ESB_BBOX)
    assert (df["year_built"] != 0).all()


def test_points_in_bbox_over_water_is_empty():
    df = pluto.points_in_bbox(WATER_BBOX)
    assert len(df) == 0
    assert set(df.columns) == {"lat", "lng", "year_built"}
