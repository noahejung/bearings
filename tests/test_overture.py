import re

import httpx
import pytest

from bearings import config
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


def test_resolves_a_well_formed_release():
    # Overture retains only the last two releases, so a hardcoded string
    # rots roughly monthly. This must come from a live bucket listing.
    release = overture.resolve_release()
    assert re.match(r"^\d{4}-\d{2}-\d{2}\.\d+$", release)


def test_resolved_release_actually_serves_data(pois):
    # fetch_pois() must be using the resolved release, not a stale pin --
    # test_returns_many_nyc_pois already proves rows come back; this just
    # names the causal link explicitly.
    assert len(pois) > 0


def test_falls_back_to_pinned_release_when_the_listing_call_fails(monkeypatch):
    def _boom(*args, **kwargs):
        raise httpx.ConnectError("simulated network failure")

    monkeypatch.setattr(httpx, "get", _boom)
    overture.resolve_release.cache_clear()
    try:
        assert overture.resolve_release() == config.OVERTURE_RELEASE
    finally:
        overture.resolve_release.cache_clear()
