from datetime import datetime, timezone

import pytest

from bearings.sources import heat

# 1040B East 217 St, Bronx. Confirmed live 2026-07-13: 2,401 HEAT/HOT WATER
# 311 complaints filed against this exact bbl during the 2025-10-01 ..
# 2026-05-31 heating season -- the single worst building in the city for
# this metric that season. The season is already closed (created_date <
# 2026-06-01 is a hard, historical boundary), so unlike some of this
# project's other live fixtures (e.g. HPD open-violation counts, which
# really can drift), this exact count cannot change on a re-run.
KNOWN_HEAT_BBL = "2046990051"

# The same hotspot building's own (lat, lng), for the point/radius fallback
# path. Confirmed live: within a 50m radius this picks up 2,693 complaints
# -- more than the bbl-exact count (2,401), because the radius also catches
# neighbouring buildings' complaints. That gap is the whole reason the
# module docstring insists "near this point" and "in this building" are
# different facts.
HOTSPOT_POINT = (40.8792011486289, -73.85429350155603)

# Open water south of Staten Island -- no address, no possible complaint.
OPEN_WATER = (40.45, -74.05)


def test_known_bbl_heat_complaints():
    r = heat.complaints(KNOWN_HEAT_BBL, seasons=1)
    assert r["complaints"] == 2401
    assert r["joined_on"] == "bbl"


def test_point_fallback_finds_more_than_the_bbl_join():
    # Same physical hotspot, radius join instead of bbl join -- must be a
    # different (larger) number, and must say so via joined_on, or a
    # caller could mistake "near this point" for "in this building".
    r = heat.complaints(HOTSPOT_POINT, seasons=1)
    assert r["joined_on"] == "point"
    assert r["complaints"] == 2693
    assert r["complaints"] > 2401  # strictly more than the bbl-exact count


def test_open_water_point_is_zero():
    r = heat.complaints(OPEN_WATER, seasons=1)
    assert r["complaints"] == 0


def test_two_seasons_is_at_least_one_season():
    one = heat.complaints(KNOWN_HEAT_BBL, seasons=1)
    two = heat.complaints(KNOWN_HEAT_BBL, seasons=2)
    assert two["complaints"] >= one["complaints"]


def test_exposes_its_source():
    assert heat.SOURCE["name"] == "NYC 311"
    assert "erm2-nwe9" in heat.SOURCE["url"]


# --- _season_bounds: pure date-math, no network ---


@pytest.mark.parametrize(
    "now_str,expected_start,expected_end",
    [
        # Deep in a heating season (Jan) -> that season is the current one,
        # started last October, not yet closed.
        ("2026-01-15T00:00:00+00:00", "2025-10-01T00:00:00", "2026-06-01T00:00:00"),
        # Early in a heating season (Nov) -> started this October.
        ("2025-11-05T00:00:00+00:00", "2025-10-01T00:00:00", "2026-06-01T00:00:00"),
        # Outside any heating season (July) -> most recently *completed*
        # season, which ended May 31 this year.
        ("2026-07-13T00:00:00+00:00", "2025-10-01T00:00:00", "2026-06-01T00:00:00"),
    ],
)
def test_season_bounds_single_season(now_str, expected_start, expected_end):
    now = datetime.fromisoformat(now_str)
    start, end = heat._season_bounds(1, now)
    assert start == expected_start
    assert end == expected_end


def test_season_bounds_multiple_seasons_extends_the_start():
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    start_1, end_1 = heat._season_bounds(1, now)
    start_2, end_2 = heat._season_bounds(2, now)
    assert end_1 == end_2
    assert start_2 < start_1
