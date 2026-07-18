"""Shared street-name-identity comparison.

Both geocode engines need the same underlying answer: "do these two street
strings actually refer to the same street," surviving abbreviation
differences ("5th Ave" (typed) vs "5 AVENUE" (PAD) vs "5TH AVENUE"
(nyc-parser, unnormalized)) without being fooled into treating two
different streets as the same. geocode.py's GeoSearch fuzzy-match guard
uses this to compare a query street against GeoSearch's result street (the
Disneyland Dr -> Shore Drive regression this guards against). geosupport_
geocode.py uses it differently -- as a *validity* check on nyc-parser's own
STREET output, to catch a live-confirmed nyc-parser bug where a street name
containing a borough word/alias ("Richmond" for Staten Island, "Queens" for
Queens) gets that word stripped along with the city/state text, leaving
nothing but a generic suffix word ("TERRACE", "BLVD") that isn't a street
identity at all -- see geosupport_geocode.py's own module docstring for the
live examples.

Originally lived inside geocode.py; extracted here once a second module
needed the same logic, rather than importing across the geocode.py <->
geosupport_geocode.py boundary (which would be circular -- geocode.py
imports geosupport_geocode.py to run the fast path first).
"""

import re

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


def street_identity(street: str) -> set[str]:
    """The set of tokens that actually identify a street name, for a
    same-street comparison that survives abbreviation differences.

    Not a proof of sameness -- two genuinely different streets that happen
    to share a non-generic word (e.g. "Infinite Loop" vs "Ash Loop") can
    still slip past this. It is a guard against the *unrelated* street case
    the original GeoSearch bug was found on, not a complete street-equality
    oracle. See the README's Known Simplifications.

    An empty return means the input carries no real street identity at all
    (either it was empty/generic to begin with, or -- geosupport_geocode.py's
    use case -- every distinguishing word got stripped out upstream).
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
