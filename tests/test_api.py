"""Tests for the FastAPI wrapper.

Uses fastapi.testclient.TestClient, whose lifespan-aware `with` form runs the
app's startup (cache warm-up) once for the module and shuts it down at the
end -- exactly the boot path the real server takes, just synchronous.
"""

import time

import pytest
from fastapi.testclient import TestClient

from bearings import cells, geocode, profile
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
    assert set(body["transit"]) == {
        "nearest_stations",
        "to_anchors",
        "unreachable_reason",
        "caveat",
        "source",
    }
    assert set(body["transit"]["to_anchors"]) == {
        "midtown",
        "wtc",
        "downtown_brooklyn",
        "newport_path",
    }
    assert set(body["transit"]["unreachable_reason"]) == {
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
        "crime_percentile",
        "crime_caveat",
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


def test_profile_reachable_anchors_carry_no_reason(client):
    # Empire State reaches every anchor with a real ride -- the reason
    # dict must be all None, never a leftover string next to a real minute
    # value (the two must always travel together, see profile.py's own
    # _anchor_result() docstring).
    resp = client.get("/api/profile", params={"address": EMPIRE_STATE})
    body = resp.json()
    for anchor, minutes in body["transit"]["to_anchors"].items():
        assert minutes >= 0
        assert body["transit"]["unreachable_reason"][anchor] is None


def test_profile_no_station_in_range_reason(client):
    # 131 Huguenot Ave, Staten Island -- confirmed live 2026-07-18: no
    # subway or PATH station of any kind falls within STATION_SEARCH_M
    # (1200m) of this real address, so `_nearby_stations()` returns an
    # empty list and every anchor gets the honest "nothing found nearby"
    # reason, not a mislabeled "not connected to the network" one.
    resp = client.get(
        "/api/profile", params={"address": "131 Huguenot Ave, Staten Island"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["transit"]["nearest_stations"] == []
    for anchor, minutes in body["transit"]["to_anchors"].items():
        assert minutes == -1
        assert body["transit"]["unreachable_reason"][anchor] == "no_station_in_range"


def test_profile_no_rail_connection_reason(client):
    # 43 Foster Rd, Staten Island -- confirmed live 2026-07-18: the two
    # real nearest stations (S15 Prince's Bay, S16 Huguenot) are both real,
    # in-range Staten Island Railway stops -- SIR has no rail path to the
    # rest of NYCT (the only crossing is the Staten Island Ferry, not in
    # this project's GTFS data), a genuinely different fact from "no
    # station nearby at all".
    resp = client.get(
        "/api/profile", params={"address": "43 Foster Rd, Staten Island"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["transit"]["nearest_stations"]) >= 1
    assert all(
        "SIR" in s["routes"] for s in body["transit"]["nearest_stations"]
    )
    for anchor, minutes in body["transit"]["to_anchors"].items():
        assert minutes == -1
        assert body["transit"]["unreachable_reason"][anchor] == "no_rail_connection"


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


def test_map_returns_the_contract_shape(client):
    resp = client.get("/api/map", params={"address": EMPIRE_STATE})
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "subject",
        "bbox",
        "buildings",
        "streets",
        "subway_lines",
        "stations",
        "cells",
        "basemap_note",
        "sources",
    }
    assert len(body["cells"]) == 37
    assert len(body["subway_lines"]) > 0
    # Empire State's block is dense -- both new base layers must carry real
    # geometry here, not just a structurally-present empty list.
    assert len(body["buildings"]) > 0
    assert len(body["streets"]) > 0
    for b in body["buildings"]:
        assert len(b["coords"]) >= 3
    for s in body["streets"]:
        assert len(s["coords"]) >= 2
        assert s["rank"] in (0, 1, 2, 3)


def test_map_bad_address_is_422_not_500(client):
    resp = client.get("/api/map", params={"address": "qqqqqqqqzzzzzzz not a real place"})
    assert resp.status_code == 422


def test_map_subway_lines_carry_route_labels(client):
    resp = client.get("/api/map", params={"address": EMPIRE_STATE})
    body = resp.json()
    assert all("route" in line for line in body["subway_lines"])
    assert all("routes" in s for s in body["stations"])


def test_citywide_returns_the_contract_shape(client):
    resp = client.get("/api/citywide")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "neighborhoods",
        "precincts",
        "neighborhoods_source",
        "precincts_source",
        "crime_source",
        "crime_caveat",
    }
    assert len(body["neighborhoods"]) > 200
    assert len(body["precincts"]) == 78
    for p in body["precincts"]:
        assert p["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_citywide_crime_is_shaded_relative_to_the_city(client):
    # VISUAL.md §5, 2026-07-15: crime is a percentile position among all
    # real NYC precincts, never a raw count on its own -- see
    # citywide.percentile_rank()'s docstring for the method.
    resp = client.get("/api/citywide")
    body = resp.json()
    with_crime = [p for p in body["precincts"] if p["crime"] is not None]
    assert len(with_crime) > 60
    for p in with_crime:
        assert 0.0 <= p["crime"]["crime_percentile"] <= 100.0
    assert len(body["crime_caveat"]) > 40


def test_reach_returns_the_full_contract_shape(client):
    resp = client.get("/api/reach", params={"address": EMPIRE_STATE})
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"center", "bands", "places", "stations", "method_note", "sources"}
    assert set(body["center"]) == {"lat", "lng"}
    assert len(body["bands"]) == 3
    minutes_seen = {b["minutes"] for b in body["bands"]}
    assert minutes_seen == {5, 10, 15}
    for band in body["bands"]:
        assert band["radius_m"] > 0
        assert len(band["polygon"]) > 3
    # A dense Midtown address has real, non-trivial places/stations, not
    # just structural empty lists.
    assert len(body["places"]) > 20
    assert len(body["stations"]) > 0
    for p in body["places"]:
        assert set(p) == {"name", "category", "lat", "lng", "band_minutes"}
    for s in body["stations"]:
        assert set(s) == {"name", "lat", "lng", "routes", "band_minutes"}
    assert "roughly" in body["method_note"].lower()
    for source in body["sources"].values():
        assert source["name"]
        assert source["url"].startswith("http")


def test_reach_bad_address_is_422_not_500(client):
    resp = client.get("/api/reach", params={"address": "qqqqqqqqzzzzzzz not a real place"})
    assert resp.status_code == 422
    assert "detail" in resp.json()


def test_cell_returns_the_precomputed_block_level_profile(client):
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    resp = client.get(f"/api/cell/{h3}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["h3"] == h3
    assert set(body) == {
        "h3",
        "shard",
        "centroid",
        "noise",
        "amenities",
        "trees",
        "benches",
        "building_age",
        "transit",
        "safety",
        "housing_hazards",
    }
    # A genuinely dense Midtown cell -- real, non-trivial signal, not just
    # structural zeros (same fixture-address reasoning test_mapgeo.py and
    # test_cellprofile.py already use).
    assert body["noise"]["complaints_12mo"] > 0
    assert body["safety"]["precinct"] == 14


def test_cell_is_fast_a_pure_lookup_not_a_live_compute(client):
    # The whole point of SPEC-precompute-v2.md's Phase 1: this must be a
    # flat read against an already-baked shard, not a live external call --
    # a real, timed regression guard, not just an assumption. Generous
    # relative to the sub-second production target (this dev machine's own
    # /api/profile is 3-10s live) so this stays robust to slow CI/dev
    # hardware without ever tolerating a live-compute-shaped 1s+ response.
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    start = time.monotonic()
    resp = client.get(f"/api/cell/{h3}")
    elapsed = time.monotonic() - start
    assert resp.status_code == 200
    assert elapsed < 2.0


def test_cell_unknown_h3_is_404_not_500(client):
    # Real syntax, no baked profile (well off Rockaway, open ocean -- see
    # test_cellprofile.py's own ocean fixture).
    ocean_cell = cells.cell_for(40.40, -73.75)
    resp = client.get(f"/api/cell/{ocean_cell}")
    assert resp.status_code == 404
    assert "detail" in resp.json()


def test_cell_garbage_h3_string_is_404_not_500(client):
    resp = client.get("/api/cell/not-a-real-h3-index")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# LAYOUT-V3 WAVE 3 (SPEC-layout-v3.md §5.2 Option A+C): GET /api/commute --
# a live single-destination commute for the editable getting-around region.
# The 4-anchor bake (GET /api/cell/{h3}) is untouched; see
# test_cell_is_fast_a_pure_lookup_not_a_live_compute above for that
# endpoint's own unaffected latency guard.
# ---------------------------------------------------------------------------


def test_commute_returns_a_real_reachable_minute_value(client):
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    resp = client.get(
        "/api/commute", params={"cell": h3, "destination": "60 West 36 St, Manhattan"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"destination", "minutes", "reason"}
    assert set(body["destination"]) == {"label", "lat", "lng"}
    assert body["reason"] is None
    assert 0 <= body["minutes"] < 15


def test_commute_wtc_area_destination_is_close_to_the_baked_wtc_anchor(client):
    # The load-bearing "this is the same machinery, not new routing logic"
    # claim is proven EXACTLY, at the Python level, by test_profile.py's
    # own test_commute_to_point_matches_the_baked_anchor_for_the_same_cell
    # (which calls commute_to_point() with config.ANCHORS' own coordinates
    # directly, no geocoder involved). This HTTP-level test instead checks
    # a real, independently-geocoded WTC-area address -- necessarily a few
    # dozen metres from the anchor's own point (confirmed live 2026-08-03:
    # "185 Greenwich St, Manhattan" snaps to a different real station,
    # WTC Cortlandt, than the anchor's own nearest station, WTC E01) -- so
    # this asserts a close real value, not a bit-for-bit match, which would
    # be a false precision claim about two genuinely different points.
    from bearings import cellprofile

    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    baked = cellprofile.profile_for(h3)
    assert baked is not None
    resp = client.get(
        "/api/commute",
        params={"cell": h3, "destination": "185 Greenwich St, Manhattan"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["reason"] is None
    assert abs(body["minutes"] - baked["transit"]["to_anchors"]["wtc"]) <= 3


def test_commute_no_rail_connection_when_destination_is_sir_only(client):
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    resp = client.get(
        "/api/commute",
        params={"cell": h3, "destination": "43 Foster Rd, Staten Island"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["minutes"] == -1
    assert body["reason"] == "no_rail_connection"


def test_commute_no_station_in_range_when_destination_is_far_from_transit(client):
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    resp = client.get(
        "/api/commute",
        params={"cell": h3, "destination": "131 Huguenot Ave, Staten Island"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["minutes"] == -1
    assert body["reason"] == "no_station_in_range"


def test_commute_unknown_cell_is_404_not_500(client):
    ocean_cell = cells.cell_for(40.40, -73.75)
    resp = client.get(
        "/api/commute", params={"cell": ocean_cell, "destination": "60 West 36 St, Manhattan"}
    )
    assert resp.status_code == 404


def test_commute_bad_destination_is_422_not_500(client):
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    resp = client.get(
        "/api/commute",
        params={"cell": h3, "destination": "qqqqqqqqzzzzzzz not a real place"},
    )
    assert resp.status_code == 422
    assert "detail" in resp.json()


def test_commute_live_compute_is_fast_once_geocode_and_graph_are_warm(client):
    # Isolates the LIVE-COMPUTE cost this endpoint actually adds (the thing
    # SPEC-layout-v3.md Wave 3 asks to measure) from the unrelated, already-
    # tolerated cost of geocoding a brand-new address (test_geocode_returns_
    # a_fast_real_point above already gives that its own generous ~5s
    # ceiling, and this endpoint reuses the exact same geocode.geocode()).
    # Pre-warming the destination's geocode here (outside the timer) mirrors
    # what re-selecting an ALREADY-PICKED autocomplete suggestion looks like
    # in the real UI -- the frontend already has the resolved point from
    # GET /api/geocode/autocomplete before it ever calls this endpoint. The
    # process is already warm by the time TestClient's lifespan startup
    # finished (profile.warm_caches() now eagerly builds transit.graph() --
    # see that function's own comment), so this should land in low tens of
    # milliseconds, matching the live measurement in this project's own
    # Wave 3 report (0-16ms once warm); a generous 2s ceiling still catches
    # a real regression without being flaky on slow CI/dev hardware.
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    destination = "1040B East 217 St, Bronx"
    geocode.geocode(destination)  # warm, outside the timer

    start = time.monotonic()
    resp = client.get("/api/commute", params={"cell": h3, "destination": destination})
    elapsed = time.monotonic() - start
    assert resp.status_code == 200
    assert elapsed < 2.0

    # And GET /api/cell/{h3}'s own bake-only path must still be fast -- a
    # direct regression guard that this new live-compute endpoint hasn't
    # slowed the untouched fast path down.
    start2 = time.monotonic()
    resp2 = client.get(f"/api/cell/{h3}")
    elapsed2 = time.monotonic() - start2
    assert resp2.status_code == 200
    assert elapsed2 < 2.0


def test_commute_session_cache_hit_on_a_repeated_destination(client):
    # SPEC-layout-v3.md §5.2 Option C, exercised through the real HTTP
    # endpoint: re-requesting the identical (cell, destination) pair must
    # not run a second Dijkstra -- a direct cache_info() check on the
    # underlying function (deterministic, not timing-based).
    loc = geocode.geocode(EMPIRE_STATE)
    h3 = cells.cell_for(loc.lat, loc.lng)
    destination = "346 East 4 St, Manhattan"
    profile.commute_to_point.cache_clear()

    resp1 = client.get("/api/commute", params={"cell": h3, "destination": destination})
    hits_after_first = profile.commute_to_point.cache_info().hits
    resp2 = client.get("/api/commute", params={"cell": h3, "destination": destination})
    hits_after_second = profile.commute_to_point.cache_info().hits

    assert resp1.status_code == resp2.status_code == 200
    assert resp1.json()["minutes"] == resp2.json()["minutes"]
    assert hits_after_second == hits_after_first + 1


def test_geocode_returns_a_fast_real_point(client):
    start = time.monotonic()
    resp = client.get("/api/geocode", params={"address": EMPIRE_STATE})
    elapsed = time.monotonic() - start
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"label", "lat", "lng", "bbl", "cell"}
    assert 40.74 < body["lat"] < 40.76
    assert -73.99 < body["lng"] < -73.98
    assert body["bbl"] is not None and body["bbl"].startswith("1")
    assert body["cell"] == cells.cell_for(body["lat"], body["lng"])
    # A single GeoSearch call, not a live profile/map compute -- generous
    # relative to a plain HTTP round trip so this stays robust on slow CI,
    # but nowhere near /api/profile's measured 6-10s.
    assert elapsed < 5.0


def test_geocode_bad_address_is_422_not_500(client):
    resp = client.get("/api/geocode", params={"address": "qqqqqqqqzzzzzzz not a real place"})
    assert resp.status_code == 422
    assert "detail" in resp.json()


def test_geocode_autocomplete_returns_real_candidates(client):
    resp = client.get("/api/geocode/autocomplete", params={"text": "350 5th"})
    assert resp.status_code == 200
    body = resp.json()
    assert "results" in body
    assert len(body["results"]) > 0
    for r in body["results"]:
        assert set(r) == {"label", "lat", "lng"}
        assert 40.47 <= r["lat"] <= 40.93


def test_geocode_autocomplete_empty_list_for_short_query_not_an_error(client):
    resp = client.get("/api/geocode/autocomplete", params={"text": "3"})
    assert resp.status_code == 200
    assert resp.json() == {"results": []}


def test_cells_returns_every_real_cell_as_a_flat_citywide_index(client):
    resp = client.get("/api/cells")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"cells"}
    assert 6_000 < len(body["cells"]) < 9_000
    sample = body["cells"][0]
    assert set(sample) == {
        "h3",
        "lat",
        "lng",
        "noise",
        "amenities",
        "trees",
        "building_age_years",
        "transit_access",
    }
    # Real cell ids, matching the same real-cell set /api/cell/{h3} serves --
    # not a fabricated grid over the NYC_BBOX rectangle (which would include
    # open water, per cellprofile.py's own module docstring).
    loc = geocode.geocode(EMPIRE_STATE)
    esb_cell = cells.cell_for(loc.lat, loc.lng)
    ids = {c["h3"] for c in body["cells"]}
    assert esb_cell in ids
    # No dupes -- every real cell appears exactly once.
    assert len(ids) == len(body["cells"])
    # Real, non-trivial signal exists somewhere in the citywide set, not
    # just structural zeros.
    assert any(c["noise"] > 0 for c in body["cells"])
    assert any(c["amenities"] > 0 for c in body["cells"])


def test_cells_is_fast_a_pure_lookup_not_a_live_compute(client):
    start = time.monotonic()
    resp = client.get("/api/cells")
    elapsed = time.monotonic() - start
    assert resp.status_code == 200
    # Generous relative to the sub-second production target for the same
    # reason test_cell_is_fast_a_pure_lookup_not_a_live_compute is -- a flat
    # ~1MB static-file read, never a live external call.
    assert elapsed < 2.0


def test_tiles_serves_the_real_basemap_archive_with_range_support(client):
    # A real MapLibre/pmtiles.js client never fetches the whole 99MB file --
    # it opens a Range request for just the byte span it needs. If this
    # endpoint didn't honour Range, the map would still "work" in a crude
    # full-download sense but would defeat the entire reason PMTiles exists.
    resp = client.get("/tiles/nyc-basemap.pmtiles", headers={"Range": "bytes=0-15"})
    assert resp.status_code == 206
    assert len(resp.content) == 16
    # PMTiles v3 magic bytes: "PMTiles" + version byte 3.
    assert resp.content[:7] == b"PMTiles"
