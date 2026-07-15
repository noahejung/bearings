"""Tests for the self-hosted NYC PMTiles basemap (VISUAL.md §5). Real
network calls throughout: resolve_build_url() HEADs the live daily-build
host, warm_cache() shells out to a real `pmtiles extract` against a real
remote archive. Requires the `pmtiles` CLI on PATH -- see README.md /
Dockerfile for how it's installed; no skip-if-missing here, matching this
repo's existing pdftotext-for-compstat.py precedent (an OS-level binary
dependency the test suite simply requires, the same way test_compstat.py
requires pdftotext)."""

import json
import subprocess

import pytest

from bearings.sources import basemap


@pytest.fixture(scope="module", autouse=True)
def warmed():
    basemap.warm_cache()


def test_resolves_a_real_recent_daily_build():
    url = basemap.resolve_build_url()
    assert url.startswith(basemap.config.PMTILES_BUILD_HOST)
    assert url.endswith(".pmtiles")


def test_warm_cache_bakes_a_real_local_archive():
    assert basemap.TILES_PATH.exists()
    # A real NYC-bbox extract at full zoom 0-15 detail is tens of MB (live-
    # measured 2026-07-15: 99MB) -- not the few-KB stub a broken/empty
    # extract would produce.
    assert basemap.TILES_PATH.stat().st_size > 10_000_000


def test_baked_archive_covers_the_real_nyc_bbox():
    out = subprocess.run(
        ["pmtiles", "show", str(basemap.TILES_PATH), "--header-json"],
        check=True,
        capture_output=True,
        text=True,
    )
    header = json.loads(out.stdout)
    bbox = basemap.config.NYC_BBOX
    min_lon, min_lat, max_lon, max_lat = header["bounds"]
    # The extracted archive's own header must actually claim the NYC bbox
    # we asked for, within a small margin (pmtiles extract snaps to whole
    # tile boundaries, so it's never pixel-exact) -- not some other city's
    # extract left behind by a stale/misconfigured cache.
    assert min_lon == pytest.approx(bbox["xmin"], abs=0.2)
    assert max_lon == pytest.approx(bbox["xmax"], abs=0.2)
    assert min_lat == pytest.approx(bbox["ymin"], abs=0.2)
    assert max_lat == pytest.approx(bbox["ymax"], abs=0.2)
    assert header["tile_type"] == "mvt"
    assert header["maxzoom"] == 15


def test_warm_cache_is_a_no_op_once_baked(monkeypatch):
    # If this tried to re-extract, it would call resolve_build_url() again
    # -- poison it so a regression here fails loudly instead of just being
    # slow.
    def _boom():
        raise AssertionError("warm_cache() re-extracted an already-baked archive")

    monkeypatch.setattr(basemap, "resolve_build_url", _boom)
    basemap.warm_cache()  # must return early, not call the poisoned resolver


def test_sources_cites_a_real_working_url():
    assert basemap.SOURCE["name"]
    assert basemap.SOURCE["url"].startswith("http")
