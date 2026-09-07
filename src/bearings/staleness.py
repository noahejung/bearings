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

import duckdb


class StaleCacheWarning(UserWarning):
    """A cached file on disk is older than its expected freshness window,
    and is being served anyway."""


class BakedSchemaOutOfDate(RuntimeError):
    """A baked Parquet file on disk predates a schema change, so the code
    that reads it and the file itself no longer agree.

    Raised, never warned. Age staleness (above) is a judgement call the
    reader can weigh -- a 40-day-old building footprint is still a real
    building. A schema mismatch is not: the columns the reader asks for are
    simply not in the file, and every outcome from there is either a crash
    with an unhelpful message or, worse, a silently wrong answer. Loud and
    named, at boot, with the exact remedy in the message.
    """


def require_baked_columns(path: Path, required: set[str], label: str) -> None:
    """Raise BakedSchemaOutOfDate unless every column in `required` is
    present in the Parquet file at `path`. A no-op if the file doesn't
    exist -- that's the not-baked-yet case, which each caller guards on its
    own with its own FileNotFoundError.

    Called from warm_cache(), i.e. once at `docker build` / at api.py's
    ASGI startup -- never per request, so it costs a single Parquet
    metadata read at boot and nothing at all on the request path.
    """
    if not path.exists():
        return

    con = duckdb.connect()
    try:
        present = {
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{path.as_posix()}')"
            ).fetchall()
        }
    finally:
        con.close()

    missing = required - present
    if missing:
        raise BakedSchemaOutOfDate(
            f"{label} at {path} was baked by an older version of this code: it is "
            f"missing {sorted(missing)} (it has {sorted(present)}). Delete the file "
            f"and re-run the bake to rebuild it in the current schema. Nothing here "
            f"tries to migrate it in place -- a half-migrated geometry file would be "
            f"a silently wrong map, not a loud failure."
        )


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
