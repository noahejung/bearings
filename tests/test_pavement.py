from bearings.sources import pavement

# A real, confirmed-live Poor-rated stretch: Arlington Avenue, the Bronx.
# Within 200m of this point, three distinct street segments each have a
# real most-recent rating on record -- 5.12 average, 0 good / 2 fair /
# 1 poor, most recent inspection 2026-03-27 -- confirmed live 2026-08-02.
# This fixture deliberately hunts for a real Poor bucket hit rather than
# settling for an all-Good/all-zero location, per this project's own "a
# test that only ever observes zeros proves nothing" rule.
POOR_STREET = (40.8795, -73.9159)

# Open water south of Staten Island -- no street, no pavement rating.
OPEN_WATER = (40.45, -74.05)


def test_near_a_real_mixed_rated_stretch():
    r = pavement.near(*POOR_STREET, radius_m=200)
    assert r is not None
    assert r["segments_rated"] >= 3
    assert r["poor"] >= 1  # a real, non-fabricated Poor hit
    assert r["good"] + r["fair"] + r["poor"] == r["segments_rated"]
    assert 0 < r["average_rating"] <= 10


def test_zero_rating_sentinel_is_never_mistaken_for_a_real_rating():
    # systemrating=0.0 means "not rated this pass" (a real nonratingreason
    # is attached), not "rated zero" -- see pavement.py's module docstring.
    # Every real rating this module returns must be a genuine 1-10 score.
    r = pavement.near(*POOR_STREET, radius_m=200)
    assert r["average_rating"] > 0


def test_far_from_anything_is_none_not_a_fabricated_zero():
    assert pavement.near(*OPEN_WATER, radius_m=400) is None


def test_exposes_its_source():
    assert pavement.SOURCE["name"] == "NYC DOT Street Pavement Ratings"
    assert "6yyb-pb25" in pavement.SOURCE["url"]
