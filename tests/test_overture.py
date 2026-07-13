import pytest

from bearings.sources import overture


@pytest.fixture(scope="module")
def pois():
    return overture.fetch_pois()


def test_returns_many_nyc_pois(pois):
    assert len(pois) > 50_000


def test_has_expected_columns(pois):
    assert {"name", "category", "lat", "lng", "cell"} <= set(pois.columns)


def test_all_points_are_inside_the_nyc_bbox(pois):
    assert pois["lat"].between(40.47, 40.93).all()
    assert pois["lng"].between(-74.30, -73.70).all()


def test_every_poi_has_an_h3_cell(pois):
    assert pois["cell"].notna().all()
    assert pois["cell"].str.startswith("89").all()


def test_categories_are_bucketed(pois):
    buckets = set(pois["category"].dropna().unique())
    # Every emitted category must be one of ours, never a raw Overture string.
    assert buckets <= set(overture.CATEGORY_MAP.values()) | {"other"}


def test_finds_grocery_stores(pois):
    assert (pois["category"] == "grocery").sum() > 100
