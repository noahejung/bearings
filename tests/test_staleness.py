import os
import time
import warnings

import pytest

from bearings import staleness

_DAY = 86400


def _age(path, days_old: float) -> None:
    """Back-date a file's mtime by `days_old` days."""
    target = time.time() - days_old * _DAY
    os.utime(path, (target, target))


def test_no_warning_for_a_fresh_file(tmp_path):
    f = tmp_path / "cache.bin"
    f.write_text("data")

    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any warning here fails the test
        staleness.warn_if_stale(f, max_age_s=7 * _DAY, label="test cache")


def test_warns_once_a_file_exceeds_its_freshness_window(tmp_path):
    f = tmp_path / "cache.bin"
    f.write_text("data")
    _age(f, days_old=10)

    with pytest.warns(staleness.StaleCacheWarning, match="test cache"):
        staleness.warn_if_stale(f, max_age_s=7 * _DAY, label="test cache")


def test_no_warning_and_no_crash_for_a_file_that_does_not_exist_yet(tmp_path):
    f = tmp_path / "never-written.bin"

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        staleness.warn_if_stale(f, max_age_s=1, label="test cache")


def test_warning_message_reports_the_real_age_in_days(tmp_path):
    f = tmp_path / "cache.bin"
    f.write_text("data")
    _age(f, days_old=14)

    with pytest.warns(staleness.StaleCacheWarning) as record:
        staleness.warn_if_stale(f, max_age_s=7 * _DAY, label="test cache")

    message = str(record[0].message)
    assert "14.0 days old" in message
    assert "7-day freshness window" in message
