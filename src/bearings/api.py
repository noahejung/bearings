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

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from bearings import factcheck, geocode, profile
from bearings.sources import overture

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
    `caveat`, and fill every amenity bucket to a real zero instead of
    letting an empty bucket vanish as a missing key."""
    transit_block = dict(prof["transit"])
    transit_block["caveat"] = TRANSIT_CAVEAT

    amenities = {category: 0 for category in AMENITY_CATEGORIES}
    amenities.update(prof["amenities"])

    return {
        "address": prof["address"],
        "cell": prof["cell"],
        "location": prof["location"],
        "transit": transit_block,
        "amenities": amenities,
        "safety": prof["safety"],
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
