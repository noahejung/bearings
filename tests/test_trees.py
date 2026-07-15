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


# --- points_in_bbox() -- per-cell tree-density metric (mapgeo.py) ---

# A real ~700m half-width box around the Empire State Building, matching
# mapgeo.py's own BBOX_RADIUS_M -- confirmed live 2026-07-15: 830 living
# trees inside it, a real non-trivial signal (not just structural zeros).
ESB_BBOX = {"south": 40.7421, "north": 40.7547, "west": -73.9957, "east": -73.9757}

# Same open-water point test_near uses above, widened to a small bbox --
# no street means no trees.
WATER_BBOX = {"south": 40.445, "north": 40.455, "west": -74.055, "east": -74.045}


def test_points_in_bbox_returns_real_nontrivial_points():
    df = trees.points_in_bbox(ESB_BBOX)
    assert len(df) > 100  # confirmed live at 830
    assert set(df.columns) == {"lat", "lng"}
    for lat, lng in zip(df["lat"], df["lng"]):
        assert ESB_BBOX["south"] < lat < ESB_BBOX["north"]
        assert ESB_BBOX["west"] < lng < ESB_BBOX["east"]


def test_points_in_bbox_over_water_is_empty():
    df = trees.points_in_bbox(WATER_BBOX)
    assert len(df) == 0
    assert set(df.columns) == {"lat", "lng"}
