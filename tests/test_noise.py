import pytest

from bearings.sources import noise

# Empire State Building corner, Midtown Manhattan -- dense enough that
# noise complaints are never zero. Confirmed live 2026-07-13: within_circle
# on this dataset's `location` Point column returns ~1297 noise complaints
# in the trailing 12 months at 400m.
EMPIRE_STATE = (40.7484, -73.9857)

# Open water south of Staten Island -- no address, no possible complaint.
OPEN_WATER = (40.45, -74.05)


def test_complaints_near_returns_a_plausible_count():
    n = noise.complaints_near(*EMPIRE_STATE, radius_m=400)
    assert isinstance(n, int)
    assert n > 500  # confirmed live at ~1297


def test_far_from_anything_is_zero():
    assert noise.complaints_near(*OPEN_WATER, radius_m=400) == 0


def test_wider_radius_finds_more_or_equal():
    small = noise.complaints_near(*EMPIRE_STATE, radius_m=200)
    large = noise.complaints_near(*EMPIRE_STATE, radius_m=800)
    assert large >= small


def test_exposes_its_source():
    assert noise.SOURCE["name"] == "NYC 311"
    assert "erm2-nwe9" in noise.SOURCE["url"]
