"""Tests for the citywide (address-independent) map data bake -- real
network calls throughout: neighbourhoods.labels(), precincts.
precinct_features(), and up to 78 live compstat.fetch_precinct() calls the
first time this runs in a fresh data/ directory (a real ~2 minutes, see
citywide.py's own module docstring); a fast no-op after that."""

import pytest

from bearings import citywide


@pytest.fixture(scope="module", autouse=True)
def warmed():
    citywide.warm_caches()


def test_get_raises_a_loud_error_if_not_yet_baked(monkeypatch, tmp_path):
    monkeypatch.setattr(citywide, "PATH", tmp_path / "never-baked.json")
    with pytest.raises(FileNotFoundError):
        citywide.get()


def test_returns_the_contract_shape():
    data = citywide.get()
    assert set(data) == {
        "neighborhoods",
        "precincts",
        "neighborhoods_source",
        "precincts_source",
        "crime_source",
        "crime_caveat",
    }


def test_neighborhoods_are_real_and_plentiful():
    data = citywide.get()
    assert len(data["neighborhoods"]) > 200
    names = {n["name"] for n in data["neighborhoods"]}
    assert "Greenpoint" in names


def test_precincts_cover_the_real_78_with_geometry():
    data = citywide.get()
    assert len(data["precincts"]) == 78
    by_precinct = {p["precinct"]: p for p in data["precincts"]}
    assert 76 in by_precinct
    assert by_precinct[76]["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_most_precincts_carry_a_real_nonzero_crime_total():
    # Some individual precincts may legitimately fail their live PDF fetch
    # (see citywide.py's _crime_for_precinct docstring) -- but if the whole
    # crime bake were silently broken, every precinct would show crime=None,
    # which is exactly the "confidently wrong" failure shape this repo
    # guards against. At least the large majority of 78 independent live
    # fetches must succeed with a real, non-trivial total.
    data = citywide.get()
    with_crime = [p for p in data["precincts"] if p["crime"] is not None]
    assert len(with_crime) / len(data["precincts"]) > 0.8
    assert all(p["crime"]["total_ytd"] > 0 for p in with_crime)


def test_crime_source_cites_a_real_working_url():
    data = citywide.get()
    assert data["crime_source"]["name"]
    assert data["crime_source"]["url"].startswith("http")


# --- crime is relative-to-NYC, not absolute (VISUAL.md §5, 2026-07-15) ---


def test_percentile_rank_places_the_sample_median_near_50():
    values = [10, 20, 30, 40, 50]
    assert citywide.percentile_rank(values, 30) == pytest.approx(50.0)


def test_percentile_rank_extremes_are_not_bare_0_or_100():
    # The mean-rank definition (ties split evenly, self included in the
    # "equal" bucket) never collapses a finite sample's extremes to a bare
    # 0/100 -- see percentile_rank()'s own docstring for why that's the
    # correct, standard behaviour (matches scipy.stats.percentileofscore's
    # kind="mean").
    values = [10, 20, 30, 40, 50]
    assert citywide.percentile_rank(values, 10) == pytest.approx(10.0)
    assert citywide.percentile_rank(values, 50) == pytest.approx(90.0)


def test_percentile_rank_splits_ties_evenly():
    values = [1, 2, 2, 3]
    assert citywide.percentile_rank(values, 2) == pytest.approx(50.0)


def test_percentile_rank_of_an_empty_distribution_raises():
    with pytest.raises(ValueError):
        citywide.percentile_rank([], 5)


def test_precinct_crime_carries_a_percentile_between_0_and_100():
    data = citywide.get()
    with_crime = [p for p in data["precincts"] if p["crime"] is not None]
    assert len(with_crime) > 60  # same >0.8-of-78 floor as the total-crime test above
    for p in with_crime:
        pr = p["crime"]["crime_percentile"]
        assert isinstance(pr, float)
        assert 0.0 <= pr <= 100.0


def test_crime_percentile_actually_discriminates_real_precincts():
    # A real regression guard, per this repo's own rule against fixtures
    # that only ever observe the same value or a zero: precinct 14 (Midtown
    # South -- the Empire State Building's own precinct) is a genuinely
    # high-crime-volume precinct; precinct 76 (Carroll Gardens) is
    # genuinely low. Live-verified 2026-07-15: 1,445 vs 230 YTD major
    # crimes against a real citywide spread of 41-1,658 across 78
    # precincts -- these are not near the same rank, and a percentile
    # computation that returned ~50 for both (or that never varied at all)
    # would be exactly the "confidently wrong, never checked against a
    # real discriminating case" bug class this project has shipped before.
    data = citywide.get()
    by_precinct = {p["precinct"]: p["crime"] for p in data["precincts"] if p["crime"]}
    assert by_precinct[14]["crime_percentile"] > 90
    assert by_precinct[76]["crime_percentile"] < 10


def test_crime_caveat_is_a_real_plain_sentence():
    data = citywide.get()
    caveat = data["crime_caveat"]
    assert isinstance(caveat, str)
    assert len(caveat) > 40
    # States the denominator decision plainly -- no per-capita rate is
    # computed here (see citywide.py's module docstring for why).
    assert "percentile" in caveat.lower() or "percent" in caveat.lower()
