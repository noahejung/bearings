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
    """No usable NYC match for the given address.

    `str(e)` (the exception's own `args[0]`) stays the full internal
    diagnostic -- guard reasoning, raw GeoSearch/Geosupport text -- exactly
    as before, for server-side logs. `user_message` is new: a short, honest,
    plain-language string that is safe to show directly to a person. Every
    HTTP boundary in api.py must use `user_message`, never `str(e)`, for
    anything that reaches the response body -- see the 2026-07-28 UX audit
    finding #2, where the internal string (house-number/street "fuzzy-
    matched" wording, meant for a developer reading logs) was passing
    through HTTPException's `detail` unmodified into the frontend's error
    box. The underlying guards themselves are correct and stay untouched;
    this is presentation only."""

    def __init__(self, internal: str, user_message: str | None = None):
        super().__init__(internal)
        self.user_message = user_message or (
            "We couldn't find that address in New York City. Double-check "
            "the house number, street, and borough."
        )


@dataclass(frozen=True)
class GeocodeResult:
    label: str
    lat: float
    lng: float
    bbl: str | None


@dataclass(frozen=True)
class AutocompleteResult:
    label: str
    lat: float
    lng: float


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
        raise GeocodeError(
            f"No match for {address!r}",
            user_message="Type an address — a house number and street, at least.",
        )
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
        raise GeocodeError(
            f"No match for {address!r}",
            user_message=(
                "We couldn't find that address in New York City. Double-check "
                "the house number, street, and borough."
            ),
        )

    feat = features[0]
    lng, lat = feat["geometry"]["coordinates"]

    if not cells.in_nyc(lat, lng):
        raise GeocodeError(
            f"{address!r} resolved to ({lat}, {lng}), outside NYC",
            user_message=(
                "That address looks like it's outside New York City — bearings "
                "only covers the five boroughs."
            ),
        )

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
            f"(asked for {query_housenumber!r}) -- treating as no real match",
            user_message=(
                f"We couldn't find house number {query_housenumber} on that "
                f"street — the nearest match on file was {result_housenumber}."
            ),
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
                f"(asked for {query_street!r}) -- treating as no real match",
                user_message=(
                    f"We couldn't find a street matching {query_street!r} in New "
                    f"York City — the nearest match on file was a different "
                    f"street ({result_street!r})."
                ),
            )

    bbl = props.get("addendum", {}).get("pad", {}).get("bbl")

    return GeocodeResult(
        label=props.get("label", address),
        lat=lat,
        lng=lng,
        bbl=bbl,
    )


# ---------------------------------------------------------------------------
# Autocomplete (LAYOUT-V3 WAVE 1d item 11, 2026-08-03) -- a debounced
# typeahead for the single consolidated search bar. NYC Planning Labs
# GeoSearch's own `/v2/autocomplete` endpoint (config.GEOSEARCH_AUTOCOMPLETE_
# URL) is a REAL, separate route, not `/v2/search` with different params --
# confirmed live 2026-08-03 by probing both: same Pelias FeatureCollection
# response shape, tuned for partial input. Geosupport has no autocomplete
# capability at all (it only resolves a complete, parsed house-number/
# street/borough triple -- see this module's own docstring), so there is no
# fast-path/fallback split here the way geocode() has; every autocomplete
# call goes straight to GeoSearch.
#
# Latency, measured live 2026-08-03 (5 real queries, warm connection):
# 237ms-1.2s, median ~400-500ms once the TCP/TLS connection to GeoSearch is
# already warm (the first call in a cold process pays a ~1.5-2s connection-
# setup tax, same as geocode()'s own fallback path). This is materially
# faster than a full geocode() call (~3s median) but NOT sub-100ms -- the
# frontend (AddressSearch.tsx) debounces and shows a loading state rather
# than pretending this is instant.
# ---------------------------------------------------------------------------
# Reverse geocode (LAYOUT-V3 WAVE 6f item 7, 2026-08-11, Noah: "a bare click
# cell shows nothing. we only see 350 5th ave manhattan every time"). Root
# cause of THAT specific complaint was AddressSearch.tsx's own fixed example
# placeholder ("350 5TH AVE, MANHATTAN") reading as a stuck real value on an
# honestly-empty field (see that file's own item 7 comment) -- this endpoint
# is the other half of the fix: instead of leaving a bare cell click's field
# blank with no clue what block it's even looking at, it resolves the
# clicked cell's own centre back to a nearest real address, so the frontend
# can show "≈ <address>" instead of nothing.
#
# GEOSEARCH_REVERSE_URL's own comment (config.py) has the live verification
# that ruled out this wave's own dispatch premise (`/v1/reverse` -- 410 Gone
# on this host) in favour of the real live route, `/v2/reverse`.
def reverse_geocode(lat: float, lng: float) -> AutocompleteResult | None:
    """Nearest real NYC address to (lat, lng), or None if GeoSearch has
    nothing there (open water, a genuinely upstream failure) -- never an
    error raised up to the caller. This backs a decorative "≈ <address>"
    hint, not a fact this project's own fact-check rule governs, so a soft
    None on any failure (bad response shape, timeout, non-2xx) is the right
    default -- the caller falls back to an area label, never a blank
    exception bubbling into a 500 for what is, at most, a missing hint.
    """
    try:
        resp = httpx.get(
            config.GEOSEARCH_REVERSE_URL,
            params={"point.lat": lat, "point.lon": lng, "size": 1},
            timeout=10.0,
        )
        resp.raise_for_status()
        body = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.info("reverse_geocode upstream failure at (%s, %s): %s", lat, lng, e)
        return None

    features = body.get("features", [])
    if not features:
        return None

    feat = features[0]
    try:
        result_lng, result_lat = feat["geometry"]["coordinates"]
    except (KeyError, ValueError, TypeError):
        return None

    if not cells.in_nyc(result_lat, result_lng):
        return None

    props = feat.get("properties", {})
    label = props.get("label")
    if not label:
        return None
    return AutocompleteResult(label=label, lat=result_lat, lng=result_lng)


def autocomplete(text: str) -> list[AutocompleteResult]:
    """Up to a handful of real NYC address candidates for partial input
    `text` -- empty list for a too-short or empty query (never an error;
    a typeahead with nothing to show yet is not a failure). Every result is
    a real GeoSearch match already filtered to inside NYC (`cells.in_nyc()`,
    the same guard geocode()'s own GeoSearch path uses) -- GeoSearch's index
    is NYC-only so an out-of-NYC candidate would already be rare, but this
    keeps the same honest boundary geocode() enforces rather than assuming
    the upstream index alone is enough.
    """
    normalized = text.strip()
    if len(normalized) < 3:
        return []

    resp = httpx.get(
        config.GEOSEARCH_AUTOCOMPLETE_URL,
        params={"text": normalized},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    features = body.get("features", [])

    results: list[AutocompleteResult] = []
    for feat in features:
        lng, lat = feat["geometry"]["coordinates"]
        if not cells.in_nyc(lat, lng):
            continue
        props = feat.get("properties", {})
        results.append(AutocompleteResult(label=props.get("label", normalized), lat=lat, lng=lng))
    return results
