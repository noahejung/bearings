"""Confirm the freshness check from test_staleness.py is actually wired into
the disk-cache call sites the finding named -- not just implemented and
unused. Each test fabricates a stale cache file at the real path the module
under test reads from, then checks the warning fires on the next call.
"""

import os
import time

import pandas as pd
import pytest

from bearings import config, profile, staleness
from bearings.sources import compstat

_DAY = 86400


def _age(path, days_old: float) -> None:
    target = time.time() - days_old * _DAY
    os.utime(path, (target, target))


def test_profile_pois_warns_on_a_stale_parquet_cache(tmp_path, monkeypatch):
    fake_path = tmp_path / "pois.parquet"
    monkeypatch.setattr(profile, "_POIS_PATH", fake_path)

    df = pd.DataFrame(
        {
            "name": ["Test Deli"],
            "category": ["grocery"],
            "lat": [40.75],
            "lng": [-73.98],
            "cell": ["892a1072b5bffff"],
        }
    )
    profile._write_parquet(df, fake_path)
    _age(fake_path, days_old=45)  # past config.POI_CACHE_MAX_AGE_S (30 days)

    profile._pois.cache_clear()
    try:
        with pytest.warns(staleness.StaleCacheWarning, match="POI table"):
            profile._pois()
    finally:
        # Never leave this 1-row fake table as the process-wide cached
        # value -- every other test in the suite calls profile._pois()
        # expecting the real ~478k-row table.
        profile._pois.cache_clear()


def test_profile_anchor_times_warns_on_a_stale_json_cache(tmp_path, monkeypatch):
    fake_path = tmp_path / "anchor_times.json"
    monkeypatch.setattr(profile, "_ANCHOR_TIMES_PATH", fake_path)
    fake_path.write_text('{"midtown": {"101": 60}}')
    _age(fake_path, days_old=45)  # past config.ANCHOR_TIMES_CACHE_MAX_AGE_S (30 days)

    profile._anchor_times.cache_clear()
    try:
        with pytest.warns(staleness.StaleCacheWarning, match="anchor-times"):
            profile._anchor_times()
    finally:
        profile._anchor_times.cache_clear()


def test_compstat_download_warns_on_a_stale_cached_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    dest = tmp_path / "pct999.pdf"
    dest.write_bytes(b"%PDF-fake")
    _age(dest, days_old=15)  # past config.COMPSTAT_CACHE_MAX_AGE_S (10 days)

    with pytest.warns(staleness.StaleCacheWarning, match="precinct 999"):
        result = compstat._download(999)

    assert result == dest
