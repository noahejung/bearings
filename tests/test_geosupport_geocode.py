"""Real, non-mocked tests against the actual nyc-parser + python-geosupport
dependencies -- see geosupport_geocode.py's own module docstring for the
engine this wraps and the two live-confirmed bugs it guards against.

Two tiers, deliberately not run the same way:

1. `_parse()` tests below need only nyc-parser (pure Python, no native
   binary) plus street_identity() (pure Python, no I/O) -- these run
   everywhere, including this dev machine and CI, with zero setup.

2. `try_geocode()` tests need the real native Geosupport library
   (libgeo.so/nycgeo.dll + ~1.9GB GEOFILES data) actually loaded, which
   this dev machine (Windows, no GDE installed -- its installer is an
   interactive InstallShield GUI with no confirmed silent-install path)
   and CI (no ~480MB binary baked in) do not have. Unlike this repo's
   other OS-binary dependencies (pmtiles CLI, poppler-utils -- both under
   15MB, one `curl`/`apt-get` away, and this repo's convention is
   correctly "no skip-if-missing, just fail" for those, see
   test_basemap.py), a multi-hundred-MB binary with no Windows silent
   install is a different order of magnitude -- these are skipped, with a
   loud, specific reason, rather than forced to fail on every local run.
   They DO run for real -- no mocking -- inside the Docker image this
   dispatch built and verified (see the agent-report), which is where the
   real GDE binary actually lives, matching this project's own precedent
   of verifying build-time-baked behaviour inside the container rather
   than pretending the dev machine can stand in for it (Dockerfile's own
   `RUN uv run python -c "..."` bake-and-verify steps for buildings/
   streets/basemap/citywide/cellprofile all follow the same shape: proven
   for real, just not on every laptop).
"""

import pytest

from bearings import geosupport_geocode

_ENGINE_AVAILABLE = geosupport_geocode._engine() is not None

requires_geosupport_engine = pytest.mark.skipif(
    not _ENGINE_AVAILABLE,
    reason=(
        "Native Geosupport library not loaded in this process (no GDE "
        "binary installed -- see this file's module docstring). Verified "
        "for real inside the Docker image built for this dispatch instead; "
        "see the agent-report."
    ),
)


# ---------------------------------------------------------------------------
# Tier 1: _parse(), real nyc-parser + real street_identity(), no native lib.
# ---------------------------------------------------------------------------


def test_parses_a_clean_address():
    house_number, street, borough_code = geosupport_geocode._parse("350 5th Ave, Manhattan")
    assert house_number == "350"
    assert street == "5TH AVE"
    assert borough_code == 1


def test_parses_a_queens_hyphenated_house_number():
    house_number, street, borough_code = geosupport_geocode._parse("35-01 Vernon Blvd, Queens")
    assert house_number == "35-01"
    assert borough_code == 4


def test_raises_could_not_parse_without_a_borough():
    # The exact UX gap the hybrid design's fallback exists to cover --
    # GeoSearch silently picks one; Geosupport can't attempt this at all.
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("350 Broadway")


def test_raises_could_not_parse_for_gibberish():
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("asdkfjhaslkdjfhas")


def test_raises_could_not_parse_for_the_regression_case():
    # nyc-parser can't recognize "Anaheim, CA" as non-NYC; it just fails to
    # find a borough token at all -- which is still, correctly, a
    # could-not-parse outcome (falls back to GeoSearch, which has its own
    # separate street-identity guard -- see test_geocode.py).
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("1313 Disneyland Dr, Anaheim, CA")


def test_raises_could_not_parse_when_a_borough_word_eats_the_whole_street():
    """Live-confirmed bug (this dispatch, run inside the real Docker image):
    "10 Richmond Terrace, Staten Island, NY" -- a real, existing NYC address
    -- makes nyc-parser match "RICHMOND" (a Staten Island borough alias) as
    THE borough indicator, then strip every occurrence of it, including the
    one inside the street name itself, leaving STREET="TERRACE" -- a bare
    generic word with zero real street identity. Sending Geosupport
    "TERRACE" alone would get a false, confident rejection ("'TERRACE' NOT
    RECOGNIZED") instead of the real address. This must raise
    GeosupportCouldNotParse (fall back to GeoSearch, which resolves this
    correctly today), not proceed to Geosupport with a mutilated street."""
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("10 Richmond Terrace, Staten Island, NY")


def test_raises_could_not_parse_when_queens_eats_its_own_street_name():
    """Same live-confirmed bug, different borough alias: "Queens Blvd" ends
    up with "QUEENS" stripped from both the street name and the trailing
    city text, leaving STREET="BLVD" -- also a bare generic word."""
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("120-55 Queens Blvd, Queens")


@pytest.mark.parametrize(
    "address",
    [
        "350 5th Ave, Apt 4B, Manhattan",
        "350 5th Ave #4B, Manhattan",
        "1 Centre St, Suite 100, Manhattan",
    ],
)
def test_apartment_unit_text_does_not_leak_into_the_street(address):
    _house_number, street, _borough_code = geosupport_geocode._parse(address)
    assert "APT" not in street
    assert "4B" not in street
    assert "SUITE" not in street


@pytest.mark.parametrize(
    "address,expected_street_contains",
    [
        ("360 Smith St, Brooklyn", "ST"),
        ("360 Smith Street, Brooklyn", "STREET"),
        ("360 Smith ST, Brooklyn", "ST"),
        ("350 5th Avenue, Manhattan", "AVENUE"),
        ("350 5th Ave, Manhattan", "AVE"),
    ],
)
def test_st_vs_street_vs_ave_vs_avenue_all_parse(address, expected_street_contains):
    # nyc-parser does not normalize suffix abbreviations itself -- it just
    # preserves whichever form the user typed. Geosupport's own matching
    # engine is the one that reconciles "ST" vs "STREET" (confirmed live:
    # both resolve to the same BBL) -- this test only proves the *parse*
    # step doesn't mangle either form.
    _house_number, street, _borough_code = geosupport_geocode._parse(address)
    assert expected_street_contains in street


def test_ordinal_street_names_parse():
    house_number, street, borough_code = geosupport_geocode._parse(
        "150 East 72nd Street, Manhattan"
    )
    assert house_number == "150"
    assert borough_code == 1
    assert "72" in street


def test_named_building_addresses_parse():
    # A real, platted NYC street name ("MetroTech Center" is the actual
    # street, not just a building name) -- confirmed live it resolves to a
    # real BBL through the full Geosupport pipeline.
    house_number, street, borough_code = geosupport_geocode._parse(
        "9 Metrotech Center, Brooklyn"
    )
    assert house_number == "9"
    assert borough_code == 3
    assert "METROTECH" in street


def test_neighborhood_name_instead_of_borough_does_not_parse():
    """Real, measured limitation, not a bug this dispatch fixes: nyc-parser's
    borough_dict only recognizes borough names/abbreviations (QUEENS, QN,
    BK, etc.), not the USPS-preferred neighborhood names ("Flushing",
    "Astoria", "Jamaica") a large fraction of real Queens/Staten Island
    mailing addresses actually use instead of the borough name. This
    correctly falls through to GeoSearch (which does understand
    neighborhood names) via the existing GeosupportCouldNotParse path --
    documented here so it reads as a deliberate, observed tradeoff, not an
    unexamined gap."""
    with pytest.raises(geosupport_geocode.GeosupportCouldNotParse):
        geosupport_geocode._parse("147-31 Sanford Ave, Flushing, NY")


# ---------------------------------------------------------------------------
# Tier 2: try_geocode(), real native Geosupport library. See module
# docstring for why these are skipped outside a real GDE environment.
# ---------------------------------------------------------------------------


@requires_geosupport_engine
def test_try_geocode_returns_a_real_bbl():
    hit = geosupport_geocode.try_geocode("350 5th Ave, Manhattan")
    assert hit.bbl == "1008350041"
    assert 40.74 < hit.lat < 40.76
    assert -73.99 < hit.lng < -73.98


@requires_geosupport_engine
def test_try_geocode_accepts_grc_01_side_of_street_informational_matches():
    # Confirmed live: GRC=01 ("1 FORDHAM PLAZA IS ON RIGHT SIDE OF EAST
    # FORDHAM ROAD") is still a real, successful match -- python-geosupport
    # itself only raises for GRC > 1 (or non-digit).
    hit = geosupport_geocode.try_geocode("1 Fordham Plaza, Bronx")
    assert hit.bbl == "2030330053"


@requires_geosupport_engine
def test_try_geocode_rejects_the_regression_case_when_a_real_borough_is_supplied():
    # This is the direct test of requirement 3's hardest case: a fully-
    # formed (house_number, street, borough) triple that Geosupport's own
    # engine determines is not real. Must raise GeosupportRejected, not
    # fall through -- geocode.py's own orchestration is what turns this
    # into a 422, never a GeoSearch retry.
    with pytest.raises(geosupport_geocode.GeosupportRejected):
        geosupport_geocode.try_geocode("1313 Disneyland Dr, Bronx, NY")


@requires_geosupport_engine
def test_try_geocode_rejects_a_typo_street():
    with pytest.raises(geosupport_geocode.GeosupportRejected):
        geosupport_geocode.try_geocode("350 5th Aev, Manhattan")


@requires_geosupport_engine
def test_try_geocode_treats_grc_00_with_blank_coordinates_as_rejected():
    """Live-confirmed bug in python-geosupport==1.1.0's own error handling
    (this dispatch): it only inspects the primary GRC field, never GRC 2.
    "147-31 Sanford Ave" (a real block face in Flushing, Queens) returns
    GRC="00" (success) with GRC 2="42"/"ADDRESS NUMBER OUT OF RANGE" and a
    blank BBL/Latitude/Longitude -- no exception raised by python-geosupport
    itself. try_geocode() must catch this independently and raise
    GeosupportRejected rather than returning a GeocodeSuccess with an empty
    BBL, which would silently break every BBL-keyed downstream source
    (bedbugs/rodents/heat/flood)."""
    with pytest.raises(geosupport_geocode.GeosupportRejected):
        geosupport_geocode.try_geocode("147-31 Sanford Ave, Queens, NY")
