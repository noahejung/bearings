"""Address -> point, via NYC Planning Labs GeoSearch (free, keyless)."""

import re
from dataclasses import dataclass

import httpx

from bearings import cells, config


class GeocodeError(Exception):
    """No usable NYC match for the given address."""


@dataclass(frozen=True)
class GeocodeResult:
    label: str
    lat: float
    lng: float
    bbl: str | None


# ---------------------------------------------------------------------------
# Street-name fuzzy-match guard.
#
# The house-number guard below catches most out-of-NYC fuzzy matches, but not
# all of them: GeoSearch's PAD index will happily match "1313 Disneyland Dr,
# Anaheim, CA" to "1313 SHORE DRIVE, Bronx, NY" -- same house number,
# unrelated street -- and return it as a confident HTTP 200 (confirmed live).
# The house number alone is not sufficient; the street has to agree too.
#
# The one thing that makes this hard: PAD's `properties.street` and what a
# person actually types are almost never byte-identical even for a *correct*
# match -- "5th Ave" (typed) vs "5 AVENUE" (PAD), "W 42nd St" vs
# "WEST 42 STREET", "Court St" vs "COURT STREET". So this can't be a string
# equality check. Instead: strip generic suffix/direction words (whose
# abbreviation style varies) and ordinal suffixes from both sides, and
# compare what's left -- the words that actually identify the street. If
# there is zero overlap, the two addresses are not on the same street.
# ---------------------------------------------------------------------------

_GENERIC_STREET_WORDS = {
    "ST", "STREET", "AVE", "AVENUE", "DR", "DRIVE", "RD", "ROAD",
    "BLVD", "BOULEVARD", "PL", "PLACE", "LN", "LANE", "CT", "COURT",
    "PKWY", "PARKWAY", "TER", "TERRACE", "CIR", "CIRCLE", "SQ", "SQUARE",
    "EXPY", "EXPRESSWAY", "HWY", "HIGHWAY", "TPKE", "TURNPIKE", "PLZ", "PLAZA",
    "N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST",
}

# A small number of PAD-specific abbreviations that aren't decomposable by
# stripping a generic suffix word -- confirmed live: PAD renders "Broadway"
# as "B'WAY". Extend this as new quirks turn up; an *unlisted* quirk fails
# safe (the address is rejected as a false mismatch) rather than silently
# waving through a wrong street, which is the direction this guard exists
# to be wrong in.
_STREET_ALIASES = {"BWAY": "BROADWAY"}

_ORDINAL_SUFFIX = re.compile(r"^(\d+)(ST|ND|RD|TH)$")


def _street_identity(street: str) -> set[str]:
    """The set of tokens that actually identify a street name, for a
    same-street comparison that survives abbreviation differences.

    Not a proof of sameness -- two genuinely different streets that happen
    to share a non-generic word (e.g. "Infinite Loop" vs "Ash Loop") can
    still slip past this. It is a guard against the *unrelated* street case
    this bug was found on, not a complete street-equality oracle. See the
    README's Known Simplifications.
    """
    cleaned = re.sub(r"[.']", "", street.upper())
    tokens = (t for t in re.split(r"[\s\-]+", cleaned) if t)
    out: set[str] = set()
    for token in tokens:
        if token in _GENERIC_STREET_WORDS:
            continue
        token = _STREET_ALIASES.get(token, token)
        token = _ORDINAL_SUFFIX.sub(r"\1", token)
        out.add(token)
    return out


def geocode(address: str) -> GeocodeResult:
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
