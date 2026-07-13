import pytest

from bearings import geocode


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
