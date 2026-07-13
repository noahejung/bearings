import pytest

from bearings.sources import trees

# Empire State Building corner, Midtown Manhattan -- confirmed live
# 2026-07-13: ~283 living street trees within a 400m bounding box.
EMPIRE_STATE = (40.7484, -73.9857)

# Open water south of Staten Island -- no street, no trees.
OPEN_WATER = (40.45, -74.05)


def test_near_returns_a_plausible_count():
    n = trees.near(*EMPIRE_STATE, radius_m=400)
    assert isinstance(n, int)
    assert n > 50  # confirmed live at ~283


def test_far_from_anything_is_zero():
    assert trees.near(*OPEN_WATER, radius_m=400) == 0


def test_wider_radius_finds_more_or_equal():
    small = trees.near(*EMPIRE_STATE, radius_m=200)
    large = trees.near(*EMPIRE_STATE, radius_m=800)
    assert large >= small


def test_bbox_always_contains_the_centre_point():
    lat, lng = EMPIRE_STATE
    min_lat, max_lat, min_lng, max_lng = trees._bbox(lat, lng, 400)
    assert min_lat < lat < max_lat
    assert min_lng < lng < max_lng


def test_exposes_its_source():
    assert trees.SOURCE["name"] == "NYC Street Tree Census"
    assert "uvpi-gqnh" in trees.SOURCE["url"]
