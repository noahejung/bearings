from bearings.street_identity import street_identity


def test_survives_common_abbreviation_differences():
    # "5th Ave" (typed) vs "5 AVENUE" (PAD) -- the exact pair geocode.py's
    # own guard has to reconcile for a genuinely correct match.
    assert street_identity("5th Ave") & street_identity("5 AVENUE")
    assert street_identity("W 42nd St") & street_identity("WEST 42 STREET")
    assert street_identity("Smith St") & street_identity("SMITH STREET")


def test_rejects_a_genuinely_unrelated_street():
    # Disneyland Dr -> Shore Drive: same generic suffix, zero real overlap.
    assert street_identity("Disneyland Dr").isdisjoint(street_identity("Shore Drive"))


def test_pure_generic_words_carry_no_identity():
    # The live-confirmed nyc-parser bug this exists to catch (see
    # geosupport_geocode.py's _parse() docstring): once a borough word gets
    # stripped out of "Richmond Terrace" / "Queens Blvd", what's left is
    # nothing but a generic street-type word -- not a real street name.
    assert street_identity("Terrace") == set()
    assert street_identity("Blvd") == set()
    assert street_identity("St") == set()
    assert street_identity("") == set()


def test_named_places_are_not_treated_as_generic():
    assert street_identity("Metrotech Center") == {"METROTECH", "CENTER"}
    assert street_identity("World Trade Center") == {"WORLD", "TRADE", "CENTER"}


def test_broadway_alias():
    # Confirmed live: PAD renders "Broadway" as "B'WAY".
    assert street_identity("Broadway") == street_identity("B'way")
