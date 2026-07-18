"""Fast primary geocoder: NYC Planning's Geosupport Desktop Edition (GDE),
called through python-geosupport, fed by nyc-parser's free-text -> (house
number, street, borough) split.

geocode.py's geocode() tries this module first and only falls back to its
own slower, pre-existing GeoSearch call when this module signals "couldn't
resolve" -- see the three exception types below for exactly how that
boundary is drawn, and geocode.py's own module docstring for the caller
side of it. The short version: this module never falls back to GeoSearch on
its own behalf -- it either returns a real GeocodeSuccess, raises one of the
two "we don't know" exceptions (caller falls back), or raises
GeosupportRejected (a real, authoritative "no" from the same PAD data
GeoSearch itself is built from -- caller must NOT fall back, or it would
launder a real rejection into a fuzzy GeoSearch match, which is the exact
failure class the Disneyland Dr -> Shore Drive bug already shipped once).

python-geosupport requires NYC Planning's own native Geosupport binary plus
~1.9GB of indexed data files (libgeo.so/nycgeo.dll + GEOFILES) -- this dev
machine and CI do not have them installed (see the Dockerfile for how the
deploy image gets them at build time). _engine() below handles that
absence loudly but non-fatally: every geocode() call in a process without
the library falls back to GeoSearch, exactly as if every address had failed
to parse. This is why python-geosupport/nyc-parser are safe to add as real
pyproject.toml dependencies (pure-Python bindings, no bundled binary -- the
`import` itself never touches the native library) even though the library
they bind to is not present in local dev.

Two real, live-confirmed-in-this-dispatch bugs are guarded against here,
not assumed away -- see _parse()'s and try_geocode()'s docstrings for the
exact live queries that surfaced each one. Both were found by stress-
testing nyc-parser and python-geosupport against real NYC input, not by
reading their docs; see this dispatch's own agent-report for the full
methodology.
"""

import logging

from geosupport import Geosupport, GeosupportError
from nycparser import Parser

from bearings.street_identity import street_identity

logger = logging.getLogger("bearings.geocode.geosupport")

SOURCE = {
    "name": "NYC Geosupport Desktop Edition (NYC Dept of City Planning)",
    "url": "https://www.nyc.gov/content/planning/pages/resources/geocoding/geosupport-desktop-edition",
}


class GeosupportCouldNotParse(Exception):
    """nyc-parser could not extract a usable (house_number, street, borough)
    triple from the input -- no borough given ("350 Broadway"), no house
    number found, or the street text collapsed to nothing but generic
    suffix/direction words (see _parse()'s docstring for the live-confirmed
    borough-name-collision bug this last case guards against). A "we don't
    know" outcome, not a real answer -- geocode.py's caller falls back to
    GeoSearch for this."""


class GeosupportUnavailable(Exception):
    """The native Geosupport library isn't loadable in this process (see
    the module docstring -- no GDE binary/data in this environment). Also a
    "we don't know" outcome from this engine's perspective, not a real
    answer -- falls back to GeoSearch exactly like GeosupportCouldNotParse."""


class GeosupportRejected(Exception):
    """Geosupport's own matching engine looked at a fully-formed
    (house_number, street, borough) triple and determined it is not a real,
    resolvable address -- either a GeosupportError (GRC not 00/01:
    unrecognized street, ambiguous match, address number out of range,
    etc.) or a GRC=00 "success" that nonetheless carries no usable
    BBL/Latitude/Longitude (see try_geocode()'s docstring for the live,
    confirmed case that second branch guards -- it is a real bug in
    python-geosupport's own error handling, not a hypothetical). This IS a
    real, authoritative answer -- the caller must raise GeocodeError
    directly and must NOT fall back to GeoSearch for it (see this module's
    own docstring)."""


class GeocodeSuccess:
    __slots__ = ("label", "lat", "lng", "bbl")

    def __init__(self, label: str, lat: float, lng: float, bbl: str) -> None:
        self.label = label
        self.lat = lat
        self.lng = lng
        self.bbl = bbl


_ENGINE_LOAD_ATTEMPTED = False
_ENGINE: Geosupport | None = None


def _engine() -> Geosupport | None:
    """Lazy singleton -- construction (13-70ms, confirmed live inside the
    real deploy container, see this dispatch's agent-report) loads
    libgeo.so and touches its data files, so this only pays that cost once
    per process, matching the lazy-cache pattern the rest of this codebase
    already uses (profile.py's lru_cache'd sub-lookups).

    Deliberately catches every Exception, not just GeosupportError:
    confirmed live that a missing-library failure raises OSError (wrapped
    by python-geosupport as GeosupportError) on Linux, but a *plain*
    Exception on Windows -- python-geosupport's own build_win_dll_path()
    raises a bare Exception when it can't find nycgeo.dll on PATH, which is
    NOT caught by python-geosupport's own OSError-only except clause (see
    geosupport/platform_utils.py, geosupport/geosupport.py in the
    ishiland/python-geosupport source). Any failure here means "this engine
    cannot be used in this process" -- exactly the GeosupportUnavailable /
    GeoSearch-fallback case, regardless of which exception type the
    underlying platform happened to raise. This is also what lets this
    dev machine (no GDE binary installed, Windows, no nycgeo.dll anywhere
    on PATH) and CI both run the full test suite against the GeoSearch
    fallback path without special-casing either one.
    """
    global _ENGINE_LOAD_ATTEMPTED, _ENGINE
    if _ENGINE_LOAD_ATTEMPTED:
        return _ENGINE
    _ENGINE_LOAD_ATTEMPTED = True
    try:
        _ENGINE = Geosupport()
        logger.info("engine=geosupport-load status=ok")
    except Exception as e:  # noqa: BLE001 -- see docstring above
        logger.warning(
            "engine=geosupport-load status=unavailable reason=%r -- "
            "every geocode() call in this process will use the GeoSearch "
            "fallback",
            str(e),
        )
    return _ENGINE


_PARSER = Parser()


def _parse(address: str) -> tuple[str, str, int]:
    """address -> (house_number, street, borough_code). Raises
    GeosupportCouldNotParse if any of the three can't be determined.

    Live-confirmed bug (2026-07-18, this dispatch): nyc-parser's borough
    detection is a plain substring/word search over the *whole* remaining
    input, including the street name itself -- so a street whose name
    happens to contain a borough word or alias ("Richmond" for Staten
    Island, "Queens" for Queens, "Kings" for Brooklyn) gets that word
    matched as THE borough indicator, and nyc-parser then strips every
    occurrence of every matched borough name out of the street text too,
    not just the city/state portion. Confirmed live inside the real deploy
    container: "10 Richmond Terrace, Staten Island, NY" parses to
    STREET="TERRACE" (bare generic word, "RICHMOND" stripped out along with
    the city name); "120-55 Queens Blvd, Queens" parses to STREET="BLVD"
    the same way. Both are real, existing NYC streets/addresses that
    GeoSearch resolves correctly today -- sending Geosupport a mutilated
    street name like "TERRACE" alone gets a false, confident
    GeosupportRejected ("'TERRACE' NOT RECOGNIZED") instead of the correct
    address, which is worse than falling back. street_identity() (shared
    with GeoSearch's own fuzzy-match guard in street_identity.py) already
    knows how to tell "a real street name" from "nothing but generic
    suffix/direction words left over" -- reused here as the detector.
    """
    parsed = _PARSER.address(address)
    house_number = parsed.get("PHN")
    street = parsed.get("STREET") or ""
    borough_code = parsed.get("BOROUGH_CODE")

    if not house_number or not borough_code:
        raise GeosupportCouldNotParse(
            f"nyc-parser could not find both a house number and an NYC "
            f"borough in {address!r} (parsed: {parsed!r})"
        )

    if not street_identity(street):
        raise GeosupportCouldNotParse(
            f"nyc-parser's street text for {address!r} was {street!r}, "
            "which carries no real street identity once generic suffix/"
            "direction words are stripped -- see this function's "
            "docstring for the live-confirmed borough-name-collision bug "
            "this guards against ('Richmond Terrace' -> bare 'TERRACE', "
            "'Queens Blvd' -> bare 'BLVD'). Falling back to GeoSearch "
            "rather than sending Geosupport a mutilated street name."
        )

    return str(house_number), street, int(borough_code)


def try_geocode(address: str) -> GeocodeSuccess:
    """The fast path. Raises GeosupportCouldNotParse or GeosupportUnavailable
    for a "we don't know" outcome (caller should fall back to GeoSearch), or
    GeosupportRejected for a real, authoritative "no" (caller must NOT fall
    back -- see this module's own docstring)."""
    house_number, street, borough_code = _parse(address)

    engine = _engine()
    if engine is None:
        raise GeosupportUnavailable("Geosupport engine not loaded in this process")

    try:
        result = engine.address(
            house_number=house_number, street_name=street, borough_code=borough_code
        )
    except GeosupportError as e:
        raise GeosupportRejected(str(e)) from e

    bbl = result.get("BOROUGH BLOCK LOT (BBL)", {}).get("BOROUGH BLOCK LOT (BBL)") or ""
    lat_raw = result.get("Latitude") or ""
    lng_raw = result.get("Longitude") or ""

    # Live-confirmed bug (2026-07-18, this dispatch): python-geosupport
    # 1.1.0's own Geosupport.call() only inspects the primary "Geosupport
    # Return Code (GRC)" field before deciding whether to raise
    # GeosupportError -- it never looks at "Geosupport Return Code 2
    # (GRC 2)", a second, function-specific status field the underlying C
    # library also sets. Confirmed live inside the real deploy container:
    # house_number="147-31", street_name="SANFORD AVE", borough_code=4 (a
    # real block face in Flushing, Queens -- GRC=00's own street-level
    # fields, e.g. ZIP Code "11355" and USPS Preferred City Name
    # "FLUSHING", resolve correctly) returns GRC="00" (success, no
    # exception raised) with GRC 2="42" / Message 2="ADDRESS NUMBER OUT OF
    # RANGE" -- and BOROUGH BLOCK LOT (BBL) / Latitude / Longitude all come
    # back as empty strings. This is a real, observed behaviour of the
    # dependency exactly as shipped on PyPI (python-geosupport==1.1.0), not
    # a hypothetical edge case. A blank coordinate is not a location:
    # treat "GRC says success but BBL/lat/lng are blank" exactly like a
    # GeosupportError -- a real, authoritative rejection (see
    # GeosupportRejected's own docstring), never a "couldn't resolve."
    if not bbl or not lat_raw or not lng_raw:
        reason = (
            result.get("Message 2")
            or result.get("Message")
            or "Geosupport returned a success code with no usable BBL/coordinates"
        )
        raise GeosupportRejected(str(reason))

    house_number_display = result.get("House Number - Display Format") or house_number
    street_normalized = result.get("First Street Name Normalized") or street
    borough_name = result.get("First Borough Name") or ""
    label = f"{house_number_display} {street_normalized.title()}, {borough_name.title()}"

    return GeocodeSuccess(label=label, lat=float(lat_raw), lng=float(lng_raw), bbl=str(bbl))
