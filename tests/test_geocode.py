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
