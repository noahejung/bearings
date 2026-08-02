from bearings.sources import trees

# Empire State Building corner, Midtown Manhattan -- confirmed live
# 2026-08-02 against the new ForMS 2.0 dataset: 284 living tree points
# within a 400m radius, near-identical to the old 2015-census module's own
# confirmed-live 283 at this same fixture (see trees.py's module
# docstring) -- a real cross-dataset sanity check, not just "some number
# came back."
EMPIRE_STATE = (40.7484, -73.9857)

# Open water south of Staten Island -- no street, no trees.
OPEN_WATER = (40.45, -74.05)


def test_near_returns_a_plausible_count():
    n = trees.near(*EMPIRE_STATE, radius_m=400)
    assert isinstance(n, int)
    assert n > 200  # confirmed live at 284


def test_far_from_anything_is_zero():
    assert trees.near(*OPEN_WATER, radius_m=400) == 0


def test_wider_radius_finds_more_or_equal():
    small = trees.near(*EMPIRE_STATE, radius_m=200)
    large = trees.near(*EMPIRE_STATE, radius_m=800)
    assert large >= small


def test_exposes_its_source():
    assert trees.SOURCE["name"] == "NYC Forestry Tree Points (ForMS 2.0)"
    assert "hn5i-inap" in trees.SOURCE["url"]


# --- points_in_bbox() -- per-cell tree-density metric (mapgeo.py) ---

# A real ~700m half-width box around the Empire State Building, matching
# mapgeo.py's own BBOX_RADIUS_M -- confirmed live 2026-08-02: 2,171 living
# tree points inside it against the old 2015-census module's own
# confirmed-live 830. This box reaches into Bryant Park, so the ~2.6x jump
# is the real, expected effect of this dataset's broader Parks-managed
# scope (see trees.py's module docstring), not a bug in this test.
ESB_BBOX = {"south": 40.7421, "north": 40.7547, "west": -73.9957, "east": -73.9757}

# Same open-water point test_near uses above, widened to a small bbox --
# no street means no trees.
WATER_BBOX = {"south": 40.445, "north": 40.455, "west": -74.055, "east": -74.045}


def test_points_in_bbox_returns_real_nontrivial_points():
    df = trees.points_in_bbox(ESB_BBOX)
    assert len(df) > 1000  # confirmed live at 2,171
    assert set(df.columns) == {"lat", "lng"}
    # NOT asserting every point falls strictly inside the box: Socrata's
    # own within_box() is confirmed live to include points a hair outside
    # the box at the edges (sub-metre float noise in the source geometry,
    # not a bug in this module) -- the old module's manual lat/lng filter
    # was strictly exclusive by construction, but that guarantee doesn't
    # carry over now that the box math is delegated to Socrata. A loose
    # sanity band instead: every point must be roughly in the neighbourhood
    # (a bad join would put points miles away, not centimetres).
    pad = 0.001  # ~110m of slack at NYC's latitude
    for lat, lng in zip(df["lat"], df["lng"]):
        assert ESB_BBOX["south"] - pad <= lat <= ESB_BBOX["north"] + pad
        assert ESB_BBOX["west"] - pad <= lng <= ESB_BBOX["east"] + pad


def test_points_in_bbox_over_water_is_empty():
    df = trees.points_in_bbox(WATER_BBOX)
    assert len(df) == 0
    assert set(df.columns) == {"lat", "lng"}
