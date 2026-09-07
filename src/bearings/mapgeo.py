"""Real map geometry for one address -- the data behind VISUAL.md's hybrid
base map: real building-footprint mass, real street centrelines, and real
GTFS subway/PATH alignments and stations for the neighbourhood around an
address.

Streets and building mass were originally a stated gap here: VISUAL.md's
map spec assumed Overture's `transportation` and `buildings` themes were
"already ingested" the same way `places` is (see overture.py's
fetch_pois()), but a live probe (2026-07-14) found `transportation` is
~60GB across 128 files and `buildings` ~276GB across 512 files -- a
per-request bbox query against either does not return within 3 minutes.
That finding stands; Overture remains the wrong source for these two
layers at this codebase's data scale.

What changed: NYC Open Data's *own* building-footprint and street-centreline
datasets are a different animal from Overture's global slices -- they are
NYC-scoped from the source, not a slice of a planet-sized file, so they are
small enough (1.08M footprints, 122k centreline segments -- confirmed live
2026-07-14) to bake in full at build time the same way `warm_caches()`
already bakes the POI table and transit graph. See sources/buildings.py and
sources/streets.py for the fetch/bake/bbox-slice pipeline; this module only
does the fast request-time bbox slice against their already-baked Parquet
files (`footprints_in_bbox()` / `segments_in_bbox()`), never touching
Socrata directly for these two layers.

Subway/PATH geometry is the same story one scale smaller: sources/gtfs.py
bakes the stations and shape lines this endpoint needs into their own two
Parquet files at build time and this module bbox-slices them per request
(gtfs.stations_in_bbox() / gtfs.shape_candidates_in_bbox()), instead of
re-parsing both feeds' zips on every call the way it did until 2026-09-07.
See that module's own "Bake vs. per-request" docstring section for the
measured cost.

**Nothing in this module makes a live external call any more.** Every
layer it returns is a slice of a build-time-baked local file. That is the
whole point of the 2026-09-07 change described below, and it is worth
keeping true: a per-request call to Socrata is an unbounded third-party
dependency sitting in front of the map, and it behaved like one (a single
311 query measured 0.69s at best and 21.6s at worst across nine live calls
the same afternoon, with no application token configured to raise the
rate limit).

**The per-cell metric block is gone (REMOVED 2026-09-07).** This endpoint
used to also return a `cells` array: five metrics (311 noise, Overture
amenity counts, street trees, median PLUTO building age, a nearby-station
transit-access proxy) for all 37 cells of a k=3 disk. Three of the five
were live Socrata queries made on every single request, and they were the
dominant cost of GET /api/map: measured 2026-09-07, median of three
in-process runs, 2.38s noise + 1.13s trees + 0.47s building age against a
4.03s end-to-end total, and with far worse tails (a 17.6s noise call, an
8.3s trees call in the same session).

Nothing read it. A repo-wide grep that day -- web/src including
*.test.tsx, web/src/types.ts, the Python tests, README.md, Dockerfile,
render.yaml -- found no consumer of the `cells` field anywhere. The metric
dropdown it was written for was cut from the frontend without the backend
compute being cut with it, and the five numbers the map actually renders
come from GET /api/cells (cellprofile.cells_index()) -- a baked flat-file
read carrying the identical five metrics for EVERY real cell citywide,
not just the 37 in one address's disk. So this was duplicated work, on the
request path, feeding nothing.

Those five metrics are not lost and are not less well covered: they are
still computed, still per H3 cell, still from the same real sources, in
cellprofile.py at bake time, and tests/test_cellprofile.py asserts on them
(including the same "never just zeros" and "None means no record, 0 means
we looked" guards the deleted tests here carried). If a per-address metric
dropdown ever comes back, it should read the baked citywide index, not
re-query Socrata per request.

**Flood zone and the sparse per-building datasets (heat, rodents, bedbugs)
are deliberately NOT here.** FEMA's NFHL is a single-point-at-a-time
ArcGIS service with no bounding-box query capability and a live-confirmed
~30-50% transient-failure rate (see `sources/flood.py`'s own docstring) --
querying it once per cell (up to 37 real external calls per map load, each
with its own retry-with-backoff) is neither fast enough for a live request
nor reliable enough to bake citywide without the failure rate ballooning
build time unpredictably. Heat/rodent/bedbug complaint data is per-building
and voluntarily filed -- a quiet cell there could mean "no problem" or
could mean "nobody filed a complaint here," which is exactly the kind of
surface this project's own rule against fabricated citywide data forbids
shading a map with. That reasoning is kept here because it still governs
what may ever be shaded on this map; the dropdown it was written for is
gone (see above).
"""

import math

from bearings import cells, transit
from bearings.sources import basemap, buildings, gtfs, hpd, overture, pluto, streets

# The ~700m half-width box matching the approved prototype -- see the
# dispatch's scratchpad bearings-map.html / fetch_geo.py. (The prototype's
# k=3 37-cell disk went with the per-cell metric block on 2026-09-07;
# cellprofile.py owns that shape now.)
BBOX_RADIUS_M = 700.0

# The same eight daily-life categories api.py's report card already sums
# (overture.CATEGORY_MAP's own value set -- never the ~93%-of-NYC "other"
# bucket that map never had a real bucket of its own). Nothing in THIS
# module uses it any more, but cellprofile.py and reach.py both import it
# from here, so it stays put rather than moving and churning two callers.
AMENITY_CATEGORIES = sorted(set(overture.CATEGORY_MAP.values()))

# "Convenient walk" radius for the transit-access proxy metric -- roughly
# 6 minutes at transit.WALK_SPEED_MPS, deliberately smaller than profile.py's
# STATION_SEARCH_M=1200 (that one finds "the nearest 3 stations from a
# single point, however far"; this one asks "how much real transit sits
# within an easy walk of this specific cell"). Same note as
# AMENITY_CATEGORIES above: this module stopped using it on 2026-09-07,
# cellprofile.py still imports it from here.
TRANSIT_ACCESS_RADIUS_M = 500.0

BASEMAP_NOTE = (
    "Everything on this map is real. The base layer -- streets, land, water -- is "
    "OpenStreetMap, a free public map. Everything on top is computed fresh from the "
    "city's own records: building outlines and streets from city property maps, "
    "subway/PATH lines from the transit agencies' own schedules -- each cited to its "
    "real source elsewhere in this report, nothing estimated. Click any home or "
    "apartment building for its own real year built and safety-violation record, not "
    "just the block's average."
)

# One citation per thing this response actually carries, and no more. The
# 311-noise, Overture-amenity, street-tree and transit-access entries were
# removed on 2026-09-07 along with the `cells` field they described: a
# citation for a number that is not in the payload is the mirror image of
# this project's own "a number with no citation is a bug" rule, and just
# as misleading to whoever reads the methodology page next.
SOURCES = {
    "basemap": dict(basemap.SOURCE),
    "subway": dict(transit.SOURCE),
    "buildings": dict(buildings.SOURCE),
    "streets": dict(streets.SOURCE),
    # building_age/hazards cite the PER-BUILDING year_built and open
    # Class C count on every footprint (buildings.footprints_in_bbox()),
    # not a per-cell aggregate -- the frontend's building click card reads
    # both by name (MapView.tsx's sources.building_age / sources.hazards),
    # so these two outlived the per-cell block.
    "building_age": dict(pluto.SOURCE),
    "hazards": dict(hpd.SOURCE),
}


def _bbox_for(lat: float, lng: float, radius_m: float) -> dict:
    """A lat/lng bounding box of half-width `radius_m`, longitude-corrected
    for latitude (a degree of longitude shrinks toward the poles)."""
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    return {
        "south": lat - dlat,
        "north": lat + dlat,
        "west": lng - dlng,
        "east": lng + dlng,
    }


def _shape_touches_bbox(coords: list[tuple[float, float]], bbox: dict) -> bool:
    return any(
        bbox["south"] <= lat <= bbox["north"] and bbox["west"] <= lng <= bbox["east"]
        for lat, lng in coords
    )


def _subway_lines(bbox: dict) -> list[dict]:
    """Every real GTFS shape (subway + PATH) that passes through the bbox,
    drawn in full -- not clipped to the box, matching the prototype's own
    approach of letting the map frame do the clipping. Each line carries a
    real `route` label (e.g. "B/D/F/M", "PATH") via gtfs.shape_routes() --
    VISUAL.md's map wants subway lines "labelled by route", not just drawn.

    `shape_id` (WAVE 4, 2026-08-11) is the join key the route-line preview
    needs: GET /api/route returns the real shape_id(s) a computed commute
    actually rode, and the frontend already has every shape's full
    coordinates loaded right here (the whole subway layer is fetched once
    per address) -- filtering this existing array client-side by shape_id
    means the highlighted-route feature needs no second geometry endpoint.

    Reads the build-time-baked subway_shapes.parquet (via
    gtfs.shape_candidates_in_bbox()) rather than re-parsing both feeds'
    shapes.txt/trips.txt/routes.txt per request, which is what this
    function used to do -- see sources/gtfs.py's own "Bake vs. per-request"
    docstring section for the measured cost and why an @lru_cache on the
    raw frames was rejected. The output is unchanged: the candidate query
    is a strict superset filtered by the same _shape_touches_bbox() test
    this function always applied, in the same order.
    """
    lines: list[dict] = []
    for cand in gtfs.shape_candidates_in_bbox(bbox):
        if _shape_touches_bbox(cand["coords"], bbox):
            lines.append(
                {
                    "coords": cand["coords"],
                    "route": cand["route"],
                    "shape_id": cand["shape_id"],
                }
            )
    return lines


def map_geometry(lat: float, lng: float, bbl: str | None) -> dict:
    """Everything the map component needs for the neighbourhood around one
    point: real building/street mass, real subway/PATH lines and real
    stations. Every one of those four is a bbox slice of a build-time-baked
    Parquet file -- no live external call happens on this path, by design
    (see the module docstring for what was removed on 2026-09-07 and why,
    and for what is deliberately NOT included -- flood, heat, rodents,
    bedbugs -- and why).
    """
    bbox = _bbox_for(lat, lng, radius_m=BBOX_RADIUS_M)

    return {
        "subject": {
            "lat": lat,
            "lng": lng,
            "bbl": bbl,
            "cell": cells.cell_for(lat, lng),
        },
        "bbox": bbox,
        "buildings": buildings.footprints_in_bbox(bbox),
        "streets": streets.segments_in_bbox(bbox),
        "subway_lines": _subway_lines(bbox),
        "stations": gtfs.stations_in_bbox(bbox),
        "basemap_note": BASEMAP_NOTE,
        "sources": SOURCES,
    }


def warm_caches() -> None:
    """Bake the building-footprint, street-centreline and subway Parquet
    files if they don't already exist. Called once by Dockerfile's
    build-time step and by api.py's startup handler (mirroring
    profile.warm_caches()'s own pattern) so the first real /api/map request
    never pays the ~4-minute citywide-fetch cost -- see
    sources/buildings.py, sources/streets.py and sources/gtfs.py. Safe to
    call more than once; a no-op once the files exist."""
    buildings.warm_cache()
    streets.warm_cache()
    gtfs.warm_cache()
