"""Address -> point. Hybrid geocoder: NYC Planning's Geosupport Desktop
Edition (fast path, 13-40ms confirmed live, see this codebase's
geosupport_geocode.py) tried first, falling back to NYC Planning Labs'
GeoSearch API (free, keyless, ~3.1-3.3s median confirmed live -- the
original, still-used implementation below) only when Geosupport signals
"couldn't resolve," never when it signals a real rejection.

Why a hybrid instead of Geosupport alone: Geosupport takes pre-parsed
house-number/street/borough, not free text, so an address like "350 5th
Ave" with no borough -- which GeoSearch resolves today by silently picking
one -- is something Geosupport's own engine flatly can't attempt (missing
borough is fatal to it). The fallback exists specifically to keep that
casual-input UX working while still getting the fast path for everything
Geosupport *can* fully parse.

The load-bearing distinction, drawn in geocode() below: Geosupport raising
GeosupportCouldNotParse or GeosupportUnavailable means "we don't know" --
fall back to GeoSearch, exactly as if this were the only geocoder. Geosupport
raising GeosupportRejected means its own matching engine looked at a
complete, well-formed (house_number, street, borough) triple and determined
it is not a real address -- that is a real, authoritative answer from the
same PAD data GeoSearch itself is built from, and must NOT be laundered
into a fuzzy GeoSearch match. Getting this backwards would reintroduce the
exact class of bug _street_identity() below already exists to prevent (a
confident wrong match, not a rejection) via a different path.
"""

import logging
from dataclasses import dataclass
from functools import lru_cache

import httpx

from bearings import cells, config, geosupport_geocode
from bearings.street_identity import street_identity as _street_identity

logger = logging.getLogger("bearings.geocode")


class GeocodeError(Exception):
    """No usable NYC match for the given address."""


@dataclass(frozen=True)
class GeocodeResult:
    label: str
    lat: float
    lng: float
    bbl: str | None


# ---------------------------------------------------------------------------
# Engine-selection observability (dispatch requirement: "make the fallback
# observable" -- a silent fallback that fires on most queries would mean
# shipping the ~480MB Geosupport image for nothing, with no way to notice).
# Plain module-level counters, not a class, matching this codebase's own
# `_state = {"warm": False}` pattern in api.py -- cheap to read in a test
# without parsing log output, and logged at INFO/WARNING per-request too so
# it's visible in Render's log stream without needing a dedicated endpoint.
# ---------------------------------------------------------------------------
ENGINE_COUNTS = {"geosupport": 0, "geosearch_fallback": 0, "geosupport_rejected": 0}


def engine_counts() -> dict:
    """A copy of the running per-process tally of which engine served each
    geocode() call -- see ENGINE_COUNTS' own comment."""
    return dict(ENGINE_COUNTS)


# ---------------------------------------------------------------------------
# In-process cache, keyed on a normalized address string. Per the measurement
# report this dispatch was handed ("address search latency" 2026-07-18):
# GeoSearch's own call is ~97-99% of a cold search's total time, so caching
# repeat lookups (the demo UI's own example-address buttons, a user re-
# submitting the same search) is a real, free win on top of the Geosupport
# fast path, not a substitute for it -- most searches are still a genuinely
# new address on first visit.
#
# Deliberately does NOT cache failures: functools.lru_cache's own documented
# behaviour is that a call which raises is never cached (the exception just
# propagates), which is exactly the right choice here -- caching a transient
# GeoSearch hiccup (confirmed live elsewhere in this project: a burst of
# calls measurably 503s the geocoder) as a permanent "no match" would be a
# new, different bug class from the ones this project has already hit.
# ---------------------------------------------------------------------------


def _normalize(address: str) -> str:
    return " ".join(address.split()).upper()


def geocode(address: str) -> GeocodeResult:
    normalized = _normalize(address)
    if not normalized:
        raise GeocodeError(f"No match for {address!r}")
    return _geocode_cached(normalized)


@lru_cache(maxsize=512)
def _geocode_cached(address: str) -> GeocodeResult:
    try:
        hit = geosupport_geocode.try_geocode(address)
    except geosupport_geocode.GeosupportRejected as e:
        # A real, authoritative "no" -- never fall back (see this module's
        # own docstring for why laundering this into GeoSearch would be the
        # exact wrong-borough bug class this project has already shipped
        # once, via a different path).
        ENGINE_COUNTS["geosupport_rejected"] += 1
        logger.info("engine=geosupport-rejected address=%r reason=%r", address, str(e))
        raise GeocodeError(str(e)) from e
    except (geosupport_geocode.GeosupportCouldNotParse, geosupport_geocode.GeosupportUnavailable) as e:
        ENGINE_COUNTS["geosearch_fallback"] += 1
        logger.info(
            "engine=geosearch-fallback address=%r reason=%s: %s",
            address, type(e).__name__, e,
        )
        return _geocode_via_geosearch(address)

    ENGINE_COUNTS["geosupport"] += 1
    logger.info("engine=geosupport address=%r bbl=%s", address, hit.bbl)
    return GeocodeResult(label=hit.label, lat=hit.lat, lng=hit.lng, bbl=hit.bbl)


def _geocode_via_geosearch(address: str) -> GeocodeResult:
    resp = httpx.get(
        config.GEOSEARCH_URL,
        params={"text": address, "size": 1},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    features = body.get("features", [])

    if not features:
        raise GeocodeError(f"No match for {address!r}")

    feat = features[0]
    lng, lat = feat["geometry"]["coordinates"]

    if not cells.in_nyc(lat, lng):
        raise GeocodeError(f"{address!r} resolved to ({lat}, {lng}), outside NYC")

    props = feat.get("properties", {})

    # GeoSearch's index (NYC's PAD) contains only NYC addresses, so an
    # out-of-NYC query never comes back with an out-of-bbox coordinate -- it
    # fuzzy-matches to a same-named NYC street instead (match_type
    # "fallback"), frequently at a different house number on that street.
    # A house-number mismatch against what was actually asked for is the real
    # signal that this wasn't a genuine match; the bbox check alone cannot
    # catch this because every candidate GeoSearch can return is in NYC.
    parsed = body.get("geocoding", {}).get("query", {}).get("parsed_text", {})
    query_housenumber = parsed.get("housenumber")
    result_housenumber = props.get("housenumber")
    if (
        query_housenumber
        and result_housenumber
        and query_housenumber != result_housenumber
    ):
        raise GeocodeError(
            f"{address!r} only fuzzy-matched house number {result_housenumber!r} "
            f"(asked for {query_housenumber!r}) -- treating as no real match"
        )

    # The house number can agree by coincidence while the street is
    # completely unrelated (this is exactly how the Disneyland Dr -> Shore
    # Drive bug was found) -- see _street_identity()'s docstring.
    query_street = parsed.get("street")
    result_street = props.get("street")
    if query_street and result_street:
        query_ids = _street_identity(query_street)
        result_ids = _street_identity(result_street)
        if query_ids and result_ids and query_ids.isdisjoint(result_ids):
            raise GeocodeError(
                f"{address!r} only fuzzy-matched street {result_street!r} "
                f"(asked for {query_street!r}) -- treating as no real match"
            )

    bbl = props.get("addendum", {}).get("pad", {}).get("bbl")

    return GeocodeResult(
        label=props.get("label", address),
        lat=lat,
        lng=lng,
        bbl=bbl,
    )
