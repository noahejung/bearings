import pytest

from bearings import factcheck

# Empire State Building corner, Midtown Manhattan -- the same fixture address
# used throughout the rest of the suite (test_profile.py, test_noise.py,
# test_trees.py). Confirmed live: ~1297 311 noise complaints within 400m in
# the trailing 12 months (genuinely loud), and 34 St-Herald Sq a few
# minutes' walk away serving eight routes (genuinely transit-rich). Using
# one well-characterised address for both the "loud" and "close to transit"
# assertions keeps this suite from depending on two separately-verified
# addresses.
EMPIRE_STATE = "350 5th Ave, Manhattan"


def test_quiet_claim_is_contradicted_at_a_genuinely_loud_address():
    result = factcheck.check(EMPIRE_STATE, "A quiet retreat in the city.")
    noise_claims = [c for c in result["claims"] if c["predicate"] == "noise"]
    assert len(noise_claims) == 1
    claim = noise_claims[0]
    assert claim["status"] == "contradicted"
    assert claim["value"] > 50
    assert str(claim["value"]) in claim["evidence"]
    assert claim["source"] == {
        "name": "NYC 311",
        "url": "https://data.cityofnewyork.us/d/erm2-nwe9",
    }


def test_two_synonyms_of_the_same_predicate_in_one_clause_are_not_duplicated():
    # "quiet" and "peaceful" both match the "noise" predicate; landing in
    # the *same* comma-delimited clause must not produce two identical
    # claims for it.
    result = factcheck.check(EMPIRE_STATE, "A quiet and peaceful retreat.")
    noise_claims = [c for c in result["claims"] if c["predicate"] == "noise"]
    assert len(noise_claims) == 1


def test_steps_from_the_subway_is_supported_when_true():
    result = factcheck.check(
        EMPIRE_STATE, "Steps from the subway, this apartment has it all."
    )
    transit_claims = [c for c in result["claims"] if c["predicate"] == "transit_walk"]
    assert len(transit_claims) == 1
    assert transit_claims[0]["status"] == "supported"
    assert transit_claims[0]["value"] <= 5


def test_prime_location_is_unfalsifiable():
    result = factcheck.check(EMPIRE_STATE, "Prime location, won't last!")
    by_predicate = {c["predicate"]: c for c in result["claims"]}
    assert by_predicate["unfalsifiable"]["status"] == "unfalsifiable"
    assert by_predicate["unfalsifiable"]["value"] is None
    assert by_predicate["unfalsifiable"]["source"]["url"].startswith("http")


def test_sun_drenched_is_no_data():
    result = factcheck.check(EMPIRE_STATE, "A sun-drenched corner unit.")
    claims = [c for c in result["claims"] if c["predicate"] == "sunlight"]
    assert len(claims) == 1
    assert claims[0]["status"] == "no_data"
    assert claims[0]["value"] is None
    assert claims[0]["source"]["url"].startswith("http")


def test_newly_renovated_is_no_data():
    result = factcheck.check(EMPIRE_STATE, "Newly renovated kitchen and bath.")
    claims = [c for c in result["claims"] if c["predicate"] == "renovation"]
    assert len(claims) == 1
    assert claims[0]["status"] == "no_data"


def test_text_with_no_recognisable_claims_returns_an_empty_list():
    result = factcheck.check(EMPIRE_STATE, "A two bedroom apartment for rent.")
    assert result["claims"] == []


def test_well_maintained_reflects_the_real_violation_count():
    result = factcheck.check(EMPIRE_STATE, "An impeccably maintained building.")
    claims = [c for c in result["claims"] if c["predicate"] == "violations"]
    assert len(claims) == 1
    # The Empire State Building has a BBL, so this is checkable either way.
    assert claims[0]["status"] in {"supported", "contradicted"}
    assert claims[0]["value"] is not None
    assert claims[0]["source"] == {
        "name": "NYC PLUTO + HPD",
        "url": "https://data.cityofnewyork.us/d/wvxf-dwi5",
    }


def test_close_to_everything_reflects_real_amenity_density():
    result = factcheck.check(EMPIRE_STATE, "Close to everything you need.")
    claims = [c for c in result["claims"] if c["predicate"] == "amenities"]
    assert len(claims) == 1
    assert claims[0]["status"] == "supported"  # Midtown is dense with POIs


def test_a_packed_marketing_sentence_yields_one_claim_per_predicate():
    result = factcheck.check(
        EMPIRE_STATE,
        "Quiet, tree-lined street, steps from the subway. Newly renovated, "
        "sun-drenched, prime location -- a true gem, won't last!",
    )
    predicates = [c["predicate"] for c in result["claims"]]
    assert predicates.count("noise") == 1
    assert predicates.count("trees") == 1
    assert predicates.count("transit_walk") == 1
    assert predicates.count("renovation") == 1
    assert predicates.count("sunlight") == 1
    assert predicates.count("unfalsifiable") == 2  # "prime location" + "a true gem"


def test_every_claim_carries_a_source_with_a_real_url():
    result = factcheck.check(
        EMPIRE_STATE,
        "Quiet, tree-lined, steps from the subway, well-maintained, newly "
        "renovated, sun-drenched, close to everything, prime location.",
    )
    assert len(result["claims"]) >= 8
    for claim in result["claims"]:
        assert claim["source"]["name"]
        assert claim["source"]["url"].startswith("http")


def test_response_shape_matches_the_api_contract():
    result = factcheck.check(EMPIRE_STATE, "Quiet street.")
    assert set(result) == {"address", "claims"}
    assert isinstance(result["address"], str)
    for claim in result["claims"]:
        assert {"quote", "predicate", "status", "evidence", "value", "source"} <= set(
            claim
        )
        assert claim["status"] in {
            "supported",
            "contradicted",
            "unfalsifiable",
            "no_data",
        }
