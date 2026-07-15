"""FastAPI wrapper around the bearings engine.

Two endpoints -- GET /api/profile and POST /api/factcheck -- plus
GET /api/health. The one thing that actually matters here: profile_for()'s
first call is 60-120s (POIs over S3, two GTFS feeds, the transit graph,
Dijkstra from four anchors -- see PLAN.md/SPEC.md). If that happened inside
the first HTTP request, the demo would look broken. So every module-level
cache profile_for() depends on is warmed here, in the ASGI lifespan startup
handler, which the server (uvicorn) blocks on before it opens its listening
socket -- no request can arrive before warm-up finishes. The two slowest
pieces of that warm-up (the POI table, the anchor-time dict) are further
persisted to disk by profile.py itself, so only the very first boot in this
data directory's lifetime is ever slow; every boot after that is fast.
"""

import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from bearings import citywide, config, factcheck, geocode, mapgeo, profile, transit
from bearings.sources import basemap, compstat, overture

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout
)
logger = logging.getLogger("bearings.api")

# The eight amenity buckets overture.py ever emits (its CATEGORY_MAP's
# values, deduplicated). profile._amenities() only returns the buckets
# that actually had a hit near a given address, so a category with zero
# nearby POIs would otherwise be a *missing* key -- and per the API
# contract, missing and zero must never be confused. Filled in explicitly
# below so every response carries all eight, real zeros included.
AMENITY_CATEGORIES = sorted(set(overture.CATEGORY_MAP.values()))

TRANSIT_CAVEAT = (
    "In-vehicle time plus a nominal transfer penalty. Excludes the walk "
    "from your door and the wait on the platform. Treat as a floor, not "
    "a door-to-door estimate."
)

# Mutable, not a constant: flips to True once warm_up() finishes. A plain
# module-level dict rather than a bare global so api.py's own code and its
# tests can read the same object without a `global` statement anywhere.
_state = {"warm": False}


def _to_contract(prof: dict) -> dict:
    """Reshape profile.profile_for()'s dict to the API contract exactly:
    drop `shard` (internal, not part of the contract), add the transit
    `caveat`, fill every amenity bucket to a real zero instead of letting an
    empty bucket vanish as a missing key, and attach a `source` to every
    block that carries real numbers -- transit, amenities, and safety came
    from profile.py with no citation at all (quiet/green/building already
    carry one each). Per SourceTag.tsx's own non-negotiable: a stat without
    a citation is a bug."""
    transit_block = dict(prof["transit"])
    transit_block["caveat"] = TRANSIT_CAVEAT
    transit_block["source"] = dict(transit.SOURCE)

    # Nested (not flat) deliberately: every value in `counts` is a real int
    # (a bare zero, never a missing key -- see AMENITY_CATEGORIES above), and
    # `source` sits beside it rather than mixed into the same dict, so
    # "iterate every amenity count" never has to skip a non-numeric key.
    counts = {category: 0 for category in AMENITY_CATEGORIES}
    counts.update(prof["amenities"])
    amenities = {"counts": counts, "source": dict(overture.SOURCE)}

    # safety is `{}` when no precinct matched the point (see profile._safety)
    # -- an empty object stays empty rather than carrying a citation for
    # numbers that were never reported.
    safety = dict(prof["safety"])
    if safety:
        safety["source"] = dict(compstat.SOURCE)

    return {
        "address": prof["address"],
        "cell": prof["cell"],
        "location": prof["location"],
        "transit": transit_block,
        "amenities": amenities,
        "safety": safety,
        "quiet": prof["quiet"],
        "green": prof["green"],
        "building": prof["building"],
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start = time.monotonic()
    logger.info("warming caches (POIs, stations, transit graph, anchor times)...")

    logger.info("  POI table (Overture over S3 on a cold boot -- this is the slow part)...")
    profile.warm_caches()

    logger.info("  map base layers (building footprints + street centrelines)...")
    mapgeo.warm_caches()

    logger.info("  NYC basemap tiles (self-hosted PMTiles extract)...")
    basemap.warm_cache()

    logger.info("  citywide map data (neighbourhood labels, precinct crime)...")
    citywide.warm_caches()

    _state["warm"] = True
    logger.info("all caches warm in %.1fs -- ready to serve", time.monotonic() - start)

    yield

    logger.info("shutting down")


app = FastAPI(title="bearings", lifespan=lifespan)

# The front end runs on a different port in dev (Vite/CRA/etc. default to
# something in the 3000-5173 range). Allow any localhost/127.0.0.1 origin
# rather than hardcoding one port.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class FactcheckRequest(BaseModel):
    address: str
    listing_text: str


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "warm": _state["warm"]}


@app.get("/api/profile")
def get_profile(address: str = Query(..., min_length=1)) -> dict:
    try:
        prof = profile.profile_for(address)
    except geocode.GeocodeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _to_contract(prof)


@app.post("/api/factcheck")
def post_factcheck(body: FactcheckRequest) -> dict:
    try:
        return factcheck.check(body.address, body.listing_text)
    except geocode.GeocodeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/api/map")
def get_map(address: str = Query(..., min_length=1)) -> dict:
    """Real map geometry for the neighbourhood around `address` -- see
    mapgeo.map_geometry()'s docstring for exactly what is (subway, stations,
    per-cell noise density) and is not (streets, buildings) included, and
    why."""
    try:
        loc = geocode.geocode(address)
    except geocode.GeocodeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return mapgeo.map_geometry(loc.lat, loc.lng, loc.bbl)


@app.get("/api/citywide")
def get_citywide() -> dict:
    """Address-independent map data: every NTA neighbourhood label and
    every NYPD precinct's boundary + CompStat crime total, citywide -- see
    citywide.py's own docstring for why this is baked once rather than
    computed per address like /api/map. The frontend fetches this once when
    the map mounts, not once per address search."""
    return citywide.get()


# Serves the self-hosted PMTiles NYC basemap (and the rest of data/derived/
# -- pois.parquet, buildings.parquet, streets.parquet, citywide.json -- all
# of it real public NYC/MTA/OSM data with nothing private in it, so sharing
# the one directory rather than carving out a single-file mount costs
# nothing). Starlette's StaticFiles/FileResponse honours Range headers
# natively, which is what lets MapLibre's pmtiles.js fetch just the byte
# ranges it needs from a 99MB archive instead of the whole file. Must be
# registered before the catch-all "/" mount below, same ordering rule that
# mount's own comment already documents.
# Unconditional (unlike the web/dist mount below): StaticFiles raises at
# construction time if its directory doesn't exist yet, and on a genuinely
# fresh checkout data/derived/ doesn't exist until warm_cache()/
# warm_caches() create it -- which happens inside the ASGI lifespan
# *startup* handler, which runs after this module-level mount() call, not
# before. Creating the (possibly still-empty) directory here guarantees the
# mount always succeeds; no request reaches it before lifespan startup
# finishes filling it in (see this module's own docstring).
config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/tiles", StaticFiles(directory=config.DERIVED_DIR), name="tiles")


# Single-origin deploy: serve the built React app (web/dist, produced by
# `npm run build`) from the same FastAPI process that serves /api/*, so
# there is one origin, one port, and VITE_API_BASE_URL never has to point
# anywhere but "" (see web/src/api.ts's own comment on that). This mount
# MUST be registered last -- Starlette matches routes in registration
# order, and a Mount("/") matches every path, so registering it before the
# explicit @app.get("/api/...") routes above would swallow those requests
# first. Conditional on the directory existing so that local dev/tests
# (where nobody has run `npm run build`, and TestClient(app) just imports
# this module) never fail to construct the app -- StaticFiles raises at
# construction time if its directory is missing.
_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
if _WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=_WEB_DIST, html=True), name="frontend")
