from bearings.sources import benches

# Empire State Building corner, Midtown Manhattan -- confirmed live
# 2026-08-02: 11 benches + 3 leaning bars within 400m. Both non-zero, so
# this fixture catches a bench/leaning-bar field swap, not just "some
# number came back."
EMPIRE_STATE = (40.7484, -73.9857)

# Open water south of Staten Island -- no street furniture at all.
OPEN_WATER = (40.45, -74.05)


def test_near_returns_a_real_nonzero_split():
    r = benches.near(*EMPIRE_STATE, radius_m=400)
    assert r["benches"] > 5  # confirmed live at 11
    assert r["leaning_bars"] > 0  # confirmed live at 3 -- a real nonzero case
    assert isinstance(r["benches"], int)
    assert isinstance(r["leaning_bars"], int)


def test_far_from_anything_is_a_real_zero_not_none():
    # This dataset is a complete physical inventory -- "no bench nearby" is
    # a real, reportable zero, never a "no record" gap the way a voluntary
    # complaint dataset would be.
    r = benches.near(*OPEN_WATER, radius_m=400)
    assert r == {
        "benches": 0,
        "leaning_bars": 0,
        "source": dict(benches.SOURCE),
    }


def test_wider_radius_finds_more_or_equal():
    small = benches.near(*EMPIRE_STATE, radius_m=200)
    large = benches.near(*EMPIRE_STATE, radius_m=800)
    assert large["benches"] + large["leaning_bars"] >= small["benches"] + small["leaning_bars"]


def test_exposes_its_source():
    assert benches.SOURCE["name"] == "NYC DOT Seating Locations"
    assert "esmy-s8q5" in benches.SOURCE["url"]


# --- points_in_bbox() -- per-cell bench-density metric ---

ESB_BBOX = {"south": 40.7421, "north": 40.7547, "west": -73.9957, "east": -73.9757}
WATER_BBOX = {"south": 40.445, "north": 40.455, "west": -74.055, "east": -74.045}


def test_points_in_bbox_returns_real_nontrivial_points():
    df = benches.points_in_bbox(ESB_BBOX)
    assert len(df) > 10
    assert set(df.columns) == {"lat", "lng", "asset_subtype"}
    # See test_trees.py's note on within_box()'s live-confirmed edge slop --
    # same loose sanity band here, not a strict in-box check.
    pad = 0.001  # ~110m of slack at NYC's latitude
    for lat, lng in zip(df["lat"], df["lng"]):
        assert ESB_BBOX["south"] - pad <= lat <= ESB_BBOX["north"] + pad
        assert ESB_BBOX["west"] - pad <= lng <= ESB_BBOX["east"] + pad
    assert "LEANING BAR" in set(df["asset_subtype"])


def test_points_in_bbox_over_water_is_empty():
    df = benches.points_in_bbox(WATER_BBOX)
    assert len(df) == 0
    assert set(df.columns) == {"lat", "lng", "asset_subtype"}
