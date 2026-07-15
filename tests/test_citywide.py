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
