"""Self-hosted NYC basemap tiles -- MapLibre GL's vector background layer
(VISUAL.md §5, REVISED 2026-07-15: "navigable MapLibre, self-hosted tiles").

Protomaps publishes a daily-built planet-wide PMTiles basemap (~120GB,
zoom 0-15, OpenStreetMap + Natural Earth data -- see docs.protomaps.com/
basemaps/downloads). Downloading that file is never necessary: PMTiles is a
range-request-addressable format, so the `pmtiles` CLI (protomaps/go-pmtiles)
can extract just the NYC bounding box directly from the remote archive over
HTTP range requests -- confirmed live 2026-07-15: extracting config.NYC_BBOX
from a real ~136.7GB daily build (`build.protomaps.com/20260714.pmtiles`)
transferred 104MB across 48 range requests in ~12s, producing a 99MB local
NYC-only archive at full zoom 0-15 detail (4,171 addressed tiles).

That 99MB archive is baked once at container-build time (mirroring
buildings.py / streets.py's own build-time-bake pattern), not committed to
git and not fetched at request time -- see api.py's static `/tiles` mount
and the Dockerfile's build-time RUN step. This is a deliberate choice over
the two alternatives: committing a 99MB binary blob would bloat this repo's
git history permanently and grow by another ~99MB on every future re-bake
(the daily build changes daily); Git LFS avoids the history bloat but adds a
storage/bandwidth quota this personal repo doesn't need. Baking at build
time reuses infrastructure this repo already has (buildings.py/streets.py
proved the pattern) and keeps the promise VISUAL.md's map decision makes:
the basemap is served from this app's own origin, never hotlinked to a
third party at request time -- which is also literally what Protomaps' own
docs ask downstream users to do ("URLs may change and hotlinking to these
downloads are discouraged. Instead, you should copy the tileset to your own
Cloud Storage.").

Requires the `pmtiles` CLI on PATH -- an OS-level binary dependency, not a
Python package, in exactly the same shape as compstat.py's `pdftotext`
requirement. See Dockerfile for the install step and README.md for the
local-dev equivalent.
"""

import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import httpx

from bearings import config, staleness

SOURCE = {
    "name": "Protomaps Basemap (OpenStreetMap + Natural Earth)",
    "url": "https://docs.protomaps.com/basemaps/downloads",
}

TILES_PATH = config.DERIVED_DIR / "nyc-basemap.pmtiles"


class PmtilesBinaryMissing(RuntimeError):
    """The `pmtiles` CLI (protomaps/go-pmtiles) is not on PATH. A loud,
    named guard rather than a silently-missing basemap -- see the module
    docstring for what this binary is for and where to get it."""


class NoBasemapBuildFound(RuntimeError):
    """None of the last PMTILES_BUILD_LOOKBACK_DAYS daily builds resolved
    (HTTP HEAD 200) on build.protomaps.com. Protomaps retains roughly a
    week of daily builds (see the module docstring); if this fires, either
    the retention window changed or the host is down -- both worth
    surfacing loudly rather than silently shipping a stale/missing
    basemap."""


@lru_cache(maxsize=1)
def resolve_build_url() -> str:
    """The most recent daily planet build that actually exists, found by
    walking backward from today (UTC) -- self-resolving, like overture.py's
    resolve_release(), because Protomaps retains only the last ~week of
    daily builds and a pinned date goes stale on its own schedule."""
    today = datetime.now(timezone.utc).date()
    for offset in range(config.PMTILES_BUILD_LOOKBACK_DAYS):
        day = today - timedelta(days=offset)
        url = f"{config.PMTILES_BUILD_HOST}/{day:%Y%m%d}.pmtiles"
        resp = httpx.head(url, timeout=15.0, follow_redirects=True)
        if resp.status_code == 200:
            return url
    raise NoBasemapBuildFound(
        f"No daily Protomaps build found in the last "
        f"{config.PMTILES_BUILD_LOOKBACK_DAYS} days at {config.PMTILES_BUILD_HOST} "
        "-- the retention window or URL scheme may have changed; see "
        "https://docs.protomaps.com/basemaps/downloads."
    )


def warm_cache() -> None:
    """Bake data/derived/nyc-basemap.pmtiles if it doesn't already exist --
    a real HTTP-range-request extraction of config.NYC_BBOX from the latest
    daily planet build (see module docstring). Safe to call more than once;
    a no-op once the file exists. Raises PmtilesBinaryMissing loudly if the
    `pmtiles` CLI isn't on PATH, rather than silently skipping the basemap.

    Extracts to a temp path first and only renames into place once
    `pmtiles extract` exits 0 -- a subprocess that fails partway through
    still leaves bytes on disk at OUTPUT.pmtiles, and if that half-written
    file sat at TILES_PATH, the next call's `TILES_PATH.exists()` check
    would treat a corrupt archive as "already baked" and serve it forever.
    """
    if TILES_PATH.exists():
        staleness.warn_if_stale(TILES_PATH, config.BASEMAP_CACHE_MAX_AGE_S, "NYC basemap PMTiles")
        return

    pmtiles_bin = shutil.which("pmtiles")
    if pmtiles_bin is None:
        raise PmtilesBinaryMissing(
            "The `pmtiles` CLI is not on PATH -- required to extract the NYC "
            "bbox from Protomaps' daily basemap build without downloading the "
            "full ~120GB planet file. Install it from "
            "https://github.com/protomaps/go-pmtiles/releases (Dockerfile pins "
            "the exact version this repo builds against)."
        )

    build_url = resolve_build_url()
    bbox = config.NYC_BBOX
    bbox_arg = f"{bbox['xmin']},{bbox['ymin']},{bbox['xmax']},{bbox['ymax']}"

    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = TILES_PATH.with_suffix(".pmtiles.tmp")
    tmp_path.unlink(missing_ok=True)
    try:
        subprocess.run(
            [pmtiles_bin, "extract", build_url, str(tmp_path), f"--bbox={bbox_arg}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        tmp_path.replace(TILES_PATH)
    finally:
        tmp_path.unlink(missing_ok=True)
