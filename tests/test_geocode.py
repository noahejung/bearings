import pytest

from bearings import geocode, geosupport_geocode

requires_geosupport_engine = pytest.mark.skipif(
    geosupport_geocode._engine() is None,
    reason=(
        "Native Geosupport library not loaded in this process -- see "
        "test_geosupport_geocode.py's module docstring. Verified for real "
        "inside the Docker image built for this dispatch instead; see the "
        "agent-report."
    ),
)


def test_geocodes_a_known_address():
    r = geocode.geocode("350 5th Ave, Manhattan")
    assert 40.74 < r.lat < 40.76
    assert -73.99 < r.lng < -73.98
    assert "5" in r.label


def test_captures_bbl():
    r = geocode.geocode("350 5th Ave, Manhattan")
    # BBL is a 10-char borough-block-lot key. Manhattan = borough 1.
    assert r.bbl is not None
    assert r.bbl.startswith("1")


def test_rejects_nonsense():
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("qqqqqqqqzzzzzzz not a real place")


def test_rejects_addresses_outside_nyc():
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("1600 Pennsylvania Ave, Washington DC")


def test_rejects_a_fuzzy_match_to_an_unrelated_street_with_the_same_housenumber():
    """Regression guard for a real, confirmed-live bug: GeoSearch's PAD index
    is NYC-only, so "1313 Disneyland Dr, Anaheim, CA" fuzzy-matches to
    "1313 SHORE DRIVE, Bronx, NY" -- same house number, a completely
    unrelated street -- and previously returned that as a confident, silent
    match. The pre-existing house-number guard cannot catch this because the
    house numbers genuinely agree; only comparing the street text does.
    """
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("1313 Disneyland Dr, Anaheim, CA")


def test_rejects_a_fuzzy_match_to_an_unrelated_street_out_of_state():
    # "233 S Wacker Dr, Chicago, IL" fuzzy-matches PAD's "Doctor S Ray
    # Boulevard" -- confirmed live -- a different street with no token in
    # common once direction/suffix words are stripped.
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("233 S Wacker Dr, Chicago, IL")


@pytest.mark.parametrize(
    "address",
    [
        "350 5th Ave, Manhattan",  # "5th Ave" (typed) vs "5 AVENUE" (PAD)
        "1520 Sedgwick Ave, Bronx",  # "Sedgwick Ave" vs "SEDGWICK AVENUE"
        "360 Smith St, Brooklyn",  # "Smith St" vs "SMITH STREET"
        "9 Metrotech Center, Brooklyn",
        "3220 Netherland Ave, Bronx",
    ],
)
def test_street_guard_does_not_reject_real_addresses_on_abbreviation_differences(address):
    """The street-name guard must survive PAD normalising abbreviations
    ("5th Ave" -> "5 AVENUE") -- a naive exact-string comparison here would
    reject every genuine match in the system, which would be a far worse
    regression than the bug it fixes."""
    r = geocode.geocode(address)
    assert r.lat and r.lng


def test_caches_repeat_lookups_of_the_same_normalized_address():
    """The measurement report this dispatch was handed recommends an
    in-process cache on normalized address as a complement to whichever
    geocoder handles first-time queries. Uses an address not touched by any
    other test in this file, so the "before" cache_info() reading isn't
    already warm from an earlier test sharing the same module-level cache."""
    before = geocode._geocode_cached.cache_info()
    geocode.geocode("120 Broadway, Manhattan")
    # Deliberately different whitespace AND case -- proves normalization
    # happens before the cache key is built, not just exact-string reuse.
    geocode.geocode("  120   broadway,  MANHATTAN  ")
    after = geocode._geocode_cached.cache_info()
    assert after.hits == before.hits + 1
    assert after.misses == before.misses + 1


def test_does_not_cache_a_failed_lookup():
    """Per the dispatch's explicit requirement: caching a transient failure
    as a permanent "no match" would be a new bug class. functools.lru_cache
    never caches a call that raised, which this proves for real rather than
    asserting it as a property of the decorator alone."""
    before = geocode._geocode_cached.cache_info()
    for _ in range(2):
        with pytest.raises(geocode.GeocodeError):
            geocode.geocode("qqqqqqqqzzzzzzz not a real place, try again")
    after = geocode._geocode_cached.cache_info()
    assert after.misses == before.misses + 2
    assert after.hits == before.hits


def test_engine_counts_are_observable():
    """Requirement: "make the fallback observable." Every real geocode()
    call must be credited to exactly one engine bucket -- this is the
    engine-agnostic form of that check (it passes locally, where every call
    goes through the fallback because this dev machine has no Geosupport
    binary installed, and would equally pass wherever the fast path is
    live, without hardcoding which one)."""
    before = geocode.engine_counts()
    total_before = sum(before.values())
    geocode.geocode("233 Spring St, Manhattan")
    after = geocode.engine_counts()
    total_after = sum(after.values())
    assert total_after == total_before + 1


@requires_geosupport_engine
def test_geocode_rejects_the_regression_case_via_geosupport_without_falling_back():
    """The direct, public-API-level assertion of requirement 3's hardest
    case: once Geosupport can fully parse a (house_number, street, borough)
    triple, a real rejection from its own matching engine must surface as
    GeocodeError directly -- geocode() must NOT retry it through GeoSearch,
    which (per this project's own already-shipped regression) might
    fuzzy-match it to an unrelated real street instead of rejecting it."""
    before = geocode.engine_counts()
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("1313 Disneyland Dr, Bronx, NY")
    after = geocode.engine_counts()
    assert after["geosupport_rejected"] == before["geosupport_rejected"] + 1
    assert after["geosearch_fallback"] == before["geosearch_fallback"]
