"""Tests for the FastAPI wrapper.

Uses fastapi.testclient.TestClient, whose lifespan-aware `with` form runs the
app's startup (cache warm-up) once for the module and shuts it down at the
end -- exactly the boot path the real server takes, just synchronous.
"""

import pytest
from fastapi.testclient import TestClient

from bearings.api import app

EMPIRE_STATE = "350 5th Ave, Manhattan"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health_reports_ok_and_warm(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["warm"] is True


def test_profile_returns_the_contract_shape(client):
    resp = client.get("/api/profile", params={"address": EMPIRE_STATE})
    assert resp.status_code == 200
    body = resp.json()

    assert set(body) == {
        "address",
        "cell",
        "location",
        "transit",
        "amenities",
        "safety",
        "quiet",
        "green",
        "building",
    }
    assert set(body["location"]) == {"lat", "lng", "bbl"}
    assert set(body["transit"]) == {"nearest_stations", "to_anchors", "caveat", "source"}
    assert set(body["transit"]["to_anchors"]) == {
        "midtown",
        "wtc",
        "downtown_brooklyn",
        "newport_path",
    }
    assert set(body["amenities"]) == {"counts", "source"}
    assert set(body["amenities"]["counts"]) == {
        "grocery",
        "cafe",
        "bar",
        "restaurant",
        "pharmacy",
        "gym",
        "park",
        "laundry",
    }
    assert set(body["safety"]) == {
        "precinct",
        "week_ending",
        "robbery_ytd",
        "robbery_pct",
        "felony_assault_ytd",
        "felony_assault_pct",
        "total_ytd",
        "total_pct",
        "source",
    }
    assert set(body["quiet"]) == {"noise_complaints_12mo", "source"}
    assert set(body["green"]) == {"street_trees_nearby", "source"}
    assert set(body["building"]) == {
        "year_built",
        "era",
        "era_note",
        "hpd_open_violations",
        "source",
    }
    assert set(body["building"]["hpd_open_violations"]) == {
        "class_a",
        "class_b",
        "class_c",
    }


def test_profile_amenities_include_every_category_even_at_zero(client):
    resp = client.get("/api/profile", params={"address": EMPIRE_STATE})
    body = resp.json()
    # Midtown will not be zero everywhere, but every key must exist
    # regardless -- a missing key and a real zero must be indistinguishable
    # from "not present", which the contract forbids.
    for count in body["amenities"]["counts"].values():
        assert isinstance(count, int)


def test_profile_transit_amenities_and_safety_each_carry_a_real_source(client):
    """Regression guard: transit, amenities, and safety used to be the only
    three of the six report blocks with no citation at all, in direct
    violation of SourceTag.tsx's own stated invariant ('a stat without a
    citation is a bug') and the spec's 'every stat must carry a real,
    working source URL.'"""
    resp = client.get("/api/profile", params={"address": EMPIRE_STATE})
    body = resp.json()

    for block in (body["transit"], body["amenities"], body["safety"]):
        source = block["source"]
        assert source["name"]
        assert source["url"].startswith("http")


def test_profile_bad_address_is_422_not_500(client):
    resp = client.get("/api/profile", params={"address": "qqqqqqqqzzzzzzz not a real place"})
    assert resp.status_code == 422
    body = resp.json()
    assert "detail" in body
    assert isinstance(body["detail"], str)
    assert body["detail"]  # a real message, not empty


def test_profile_address_outside_nyc_is_422(client):
    resp = client.get(
        "/api/profile", params={"address": "1600 Pennsylvania Ave, Washington DC"}
    )
    assert resp.status_code == 422


def test_profile_missing_address_param_is_422(client):
    resp = client.get("/api/profile")
    assert resp.status_code == 422


def test_factcheck_returns_claims_for_real_listing_text(client):
    resp = client.post(
        "/api/factcheck",
        json={
            "address": EMPIRE_STATE,
            "listing_text": "A quiet, tree-lined street, steps from the subway.",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["address"]
    assert isinstance(body["claims"], list)
    assert len(body["claims"]) >= 3
    for claim in body["claims"]:
        assert {"quote", "predicate", "status", "evidence", "value", "source"} <= set(claim)
        assert claim["status"] in {"supported", "contradicted", "unfalsifiable", "no_data"}
        assert claim["source"]["name"]
        assert claim["source"]["url"].startswith("http")


def test_factcheck_bad_address_is_422_not_500(client):
    resp = client.post(
        "/api/factcheck",
        json={"address": "qqqqqqqqzzzzzzz not a real place", "listing_text": "Quiet street."},
    )
    assert resp.status_code == 422


def test_cors_allows_localhost_origin(client):
    resp = client.get(
        "/api/health", headers={"Origin": "http://localhost:5173"}
    )
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"
