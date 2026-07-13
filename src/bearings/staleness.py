"""Loud (not silent) warnings for on-disk caches past their freshness window.

Every long-lived cache in this codebase -- the Overture POI table, the
anchor-time dict, both GTFS zips, each CompStat PDF, the precinct GeoJSON --
is written once and read forever: `if path.exists(): return cached`, with no
TTL, version key, or invalidation path anywhere. That's a deliberate
tradeoff (see README's Known Simplifications: it's what makes a warm boot
fast), but it means a real answer -- 528 noise complaints, a station's
route list, a precinct's YTD crime count -- can quietly go stale for months
with nothing on screen or in the logs ever saying so. That is exactly the
"perfectly computed and completely wrong" failure shape transit.py's
AnchorSnapTooFar guard exists to prevent for the transit graph; this module
is the same principle applied to the disk caches. It does not invalidate
anything -- deleting the file is still how you force a refresh -- it only
makes staleness visible instead of silent.
"""

import time
import warnings
from pathlib import Path


class StaleCacheWarning(UserWarning):
    """A cached file on disk is older than its expected freshness window,
    and is being served anyway."""


def warn_if_stale(path: Path, max_age_s: float, label: str) -> None:
    """Emit a StaleCacheWarning if `path` exists and is older than
    `max_age_s`. A no-op if the file doesn't exist yet -- that's the normal
    first-boot case, not staleness."""
    if not path.exists():
        return

    age_s = time.time() - path.stat().st_mtime
    if age_s > max_age_s:
        warnings.warn(
            f"{label} cache at {path} is {age_s / 86400:.1f} days old, past "
            f"its {max_age_s / 86400:.0f}-day freshness window -- serving it "
            f"anyway. Delete the file to force a refresh.",
            StaleCacheWarning,
            stacklevel=2,
        )
