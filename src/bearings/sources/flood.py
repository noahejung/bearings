"""FEMA National Flood Hazard Layer -- per-point flood zone lookup.

The live REST endpoint was found by web search, not guessed: FEMA serves
the NFHL as a public ArcGIS MapServer at
`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`.
Layer 28 ("Flood Hazard Zones", polygon geometry) is the one that carries
a `FLD_ZONE` per polygon -- confirmed live by dumping the MapServer's own
layer list and then that layer's field schema, not assumed from a name.

This is a true per-point lookup, not a nearest-neighbour or bbox guess:
the query hits `.../28/query` with the caller's exact (lat, lng) as an
`esriGeometryPoint` and `spatialRel=esriSpatialRelIntersects`, so the
returned zone is whichever polygon the point physically sits inside.

`FLD_ZONE` values and what they mean come from FEMA's own published
glossary (https://www.fema.gov/about/glossary/flood-zones) and cross-
checked against this exact layer's own drawingInfo legend, not invented:
zones A/AE/AH/AO/AR/A99/V/VE are the 1%-annual-chance "base flood" /
Special Flood Hazard Area (SFHA); zone X carries two very different
meanings distinguished by `ZONE_SUBTY` -- "shaded X" (0.2 PCT ANNUAL
CHANCE FLOOD HAZARD, the 500-year floodplain) vs. plain/"unshaded" X
(AREA OF MINIMAL FLOOD HAZARD, i.e. outside any mapped hazard); zone D is
an area with no flood hazard analysis performed at all. `SFHA_TF` is the
dataset's own T/F flag for "is this point in the Special Flood Hazard
Area" and is used as-is rather than re-derived from the zone letter.

`STATIC_BFE` (Base Flood Elevation, feet) uses `-9999.0` as FEMA's own
sentinel for "not applicable to this zone" (confirmed live: every Zone X
row returns exactly -9999.0) -- that sentinel is converted to `None`
here so a caller can't mistake it for a real elevation.

A point with **zero** intersecting features (confirmed live for a point
~370 miles offshore, well outside any Flood Insurance Study) returns
`None` from `zone()` -- a different fact from "studied, Zone X", which
is a real dict with `in_special_flood_hazard_area=False`.

**`hazards.fema.gov` itself is flaky** -- confirmed live, repeatedly, in
both curl and httpx: a genuine share of requests (observed roughly
1-in-3 to 1-in-2 across repeated probes) fail with a mid-handshake
connection reset (`WinError 10054` / SSL renegotiation failure), not a
4xx/5xx or a malformed response. This is a property of that specific
FEMA host, not of NYC Open Data's Socrata domain (rock solid across every
other source in this codebase) and not of this module's request shape.
`zone()` retries a transient connection failure up to 5 times with a
short linear backoff before giving up for real -- 3 attempts was tried
first and still failed intermittently in this project's own test runs,
so the count was raised rather than the failure silently tolerated.

**On dollar figures:** this module deliberately returns no premium
estimate. NFIP premiums vary by elevation, structure type, and coverage
choices that this project has no data for (no elevation certificates, no
structure records) -- computing a specific number here would repeat this
project's exact "confidently-wrong number" failure mode. If a caller
wants general context, the citable range is: NYC median flood-insurance
premium ~$550/yr, averaging $1,449-$1,646/yr in Zone AE (Policygenius /
FEMA Risk Rating 2.0 reporting) -- stated as background about the zone,
never computed for a specific address."""

import time

import httpx

from bearings import config

SOURCE = {
    "name": "FEMA National Flood Hazard Layer",
    "url": "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
}

# FEMA's own sentinel for "no Base Flood Elevation applies to this zone".
_NO_BFE = -9999.0

_MAX_ATTEMPTS = 5
_RETRY_BACKOFF_S = 1.0

# Base description per zone letter, from FEMA's published glossary
# (fema.gov/about/glossary/flood-zones). Zone X is intentionally split by
# ZONE_SUBTY below -- "0.2% annual chance" and "minimal hazard" are very
# different facts that this single letter code conflates.
_SFHA_ZONE_DESCRIPTIONS = {
    "A": "Special Flood Hazard Area: 1% annual chance flood (the base/100-year flood). No Base Flood Elevation determined.",
    "AE": "Special Flood Hazard Area: 1% annual chance flood (the base/100-year flood), with Base Flood Elevation determined.",
    "AH": "Special Flood Hazard Area: shallow flooding (ponding), 1% annual chance, Base Flood Elevation determined.",
    "AO": "Special Flood Hazard Area: shallow flooding (sheet flow), 1% annual chance, typical flood depths shown.",
    "AR": "Special Flood Hazard Area: temporarily increased flood risk while a flood control system is being restored.",
    "A99": "Special Flood Hazard Area: to be protected by a flood control system currently under construction.",
    "V": "Special Flood Hazard Area: coastal high-hazard area subject to storm-wave action. No Base Flood Elevation determined.",
    "VE": "Special Flood Hazard Area: coastal high-hazard area subject to storm-wave action, with Base Flood Elevation determined.",
    "D": "Undetermined flood hazard: no flood hazard analysis has been performed for this area.",
}


def _describe(fld_zone: str, zone_subty: str | None) -> str:
    if fld_zone in _SFHA_ZONE_DESCRIPTIONS:
        return _SFHA_ZONE_DESCRIPTIONS[fld_zone]

    if fld_zone == "X":
        subty = (zone_subty or "").upper()
        if "0.2" in subty:
            return (
                "Moderate flood hazard: between the 1% and 0.2% annual "
                "chance flood limits (the 500-year floodplain). Not a "
                "Special Flood Hazard Area."
            )
        return (
            "Area of minimal flood hazard: outside the mapped 0.2% "
            "annual chance floodplain."
        )

    # Any other/rare code: fall back to the raw subtype text rather than
    # inventing a description for a zone this module hasn't seen live.
    return zone_subty or f"FEMA flood zone {fld_zone} (no further description on record)."


def _query(params: dict[str, object]) -> httpx.Response:
    """GET with a bounded retry -- see module docstring for why this host
    specifically needs one when nothing else in this codebase does."""
    last_exc: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = httpx.get(config.FEMA_NFHL_QUERY_URL, params=params, timeout=30.0)
            resp.raise_for_status()
            return resp
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(_RETRY_BACKOFF_S * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def zone(lat: float, lng: float) -> dict | None:
    """The FEMA flood zone at an exact point, or `None` if no NFHL flood
    study covers this location (see module docstring -- that is a
    different fact from "studied, zone X")."""
    params = {
        "geometry": f"{lng},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
        "returnGeometry": "false",
        "f": "json",
    }
    resp = _query(params)
    features = resp.json().get("features", [])
    if not features:
        return None

    attrs = features[0]["attributes"]
    fld_zone = attrs["FLD_ZONE"]
    zone_subty = attrs.get("ZONE_SUBTY")
    bfe = attrs.get("STATIC_BFE")

    return {
        "zone": fld_zone,
        "description": _describe(fld_zone, zone_subty),
        "in_special_flood_hazard_area": attrs.get("SFHA_TF") == "T",
        "base_flood_elevation_ft": None if bfe in (None, _NO_BFE) else bfe,
        "source": dict(SOURCE),
    }
