import pytest

from bearings import profile


@pytest.fixture(scope="module")
def empire_state():
    return profile.profile_for("350 5th Ave, Manhattan")


def test_has_the_expected_top_level_shape(empire_state):
    assert {"address", "cell", "shard", "location", "transit", "amenities", "safety"} <= set(empire_state)


def test_midtown_has_a_short_commute_to_midtown(empire_state):
    assert empire_state["transit"]["to_anchors"]["midtown"] < 15


def test_midtown_is_farther_from_newport(empire_state):
    a = empire_state["transit"]["to_anchors"]
    assert a["newport_path"] > a["midtown"]


def test_empire_state_anchors_carry_no_unreachable_reason(empire_state):
    # Every anchor is a real, reachable ride from Empire State -- the
    # reason dict must be all None, never a leftover string sitting next
    # to a real minute value (see profile.py's _anchor_result() docstring
    # for why the two always travel together).
    reasons = empire_state["transit"]["unreachable_reason"]
    assert set(reasons) == {"midtown", "wtc", "downtown_brooklyn", "newport_path"}
    assert all(r is None for r in reasons.values())


def test_no_station_in_range_at_a_real_staten_island_address():
    # 131 Huguenot Ave, Staten Island -- confirmed live 2026-07-18: no
    # subway or PATH station of any kind falls within STATION_SEARCH_M
    # (1200m) of this real, geocodable address, so _nearby_stations()
    # returns an empty list. This is the honest "nothing nearby" case,
    # distinct from a station being right there but disconnected.
    prof = profile.profile_for("131 Huguenot Ave, Staten Island")
    assert prof["transit"]["nearest_stations"] == []
    to_anchors = prof["transit"]["to_anchors"]
    reasons = prof["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert minutes == -1
        assert reasons[anchor] == "no_station_in_range"


def test_no_rail_connection_at_a_real_staten_island_railway_address():
    # 43 Foster Rd, Staten Island -- confirmed live 2026-07-18: the two
    # real nearest stations (S15 Prince's Bay, S16 Huguenot) are both real,
    # in-range Staten Island Railway stops. SIR has no rail path to the
    # rest of NYCT -- the only crossing is the Staten Island Ferry, which
    # isn't in this project's GTFS schedule data -- a real, permanent gap,
    # not a bug, and a different fact from "no station nearby at all".
    prof = profile.profile_for("43 Foster Rd, Staten Island")
    stations = prof["transit"]["nearest_stations"]
    assert len(stations) >= 1
    assert all("SIR" in s["routes"] for s in stations)
    to_anchors = prof["transit"]["to_anchors"]
    reasons = prof["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert minutes == -1
        assert reasons[anchor] == "no_rail_connection"


def test_disconnected_stop_ids_is_exactly_staten_island_railway_today():
    # A live, direct check of the guard itself (profile.py's
    # UnexplainedDisconnectedStation): as of the 2026-07-18 gtfs.stations()
    # dedup fix, the only real network gap left is Staten Island Railway
    # (21 stations, St George to Tottenville) -- calling this must not
    # raise, and every id it returns must be a real "S"-prefixed SIR stop.
    disconnected = profile._disconnected_stop_ids()
    assert len(disconnected) == 21
    assert all(stop_id.startswith("S") for stop_id in disconnected)


def test_finds_nearby_stations(empire_state):
    stations = empire_state["transit"]["nearest_stations"]
    assert len(stations) >= 1
    assert stations[0]["walk_minutes"] < 15
    assert stations[0]["routes"]


def test_midtown_is_dense_with_amenities(empire_state):
    a = empire_state["amenities"]
    assert a["restaurant"] > 10
    assert a["cafe"] > 3


def test_carroll_gardens_is_quieter_than_midtown(empire_state):
    """A real regression guard: the profile must actually discriminate.

    NYC GeoSearch (geocode.py) is an address-point geocoder, not an
    intersection geocoder -- "Carroll St and Smith St, Brooklyn" returns
    zero features (verified live). "360 Smith St, Brooklyn" is a real,
    resolvable address at (40.6794, -73.9958), essentially the same corner
    the intersection query was reaching for.
    """
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["amenities"]["restaurant"] < empire_state["amenities"]["restaurant"]
    assert cg["cell"] != empire_state["cell"]


def test_safety_is_populated(empire_state):
    s = empire_state["safety"]
    assert s["precinct"] > 0
    assert s["total_ytd"] > 0


def test_carroll_gardens_lands_in_the_76th():
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["safety"]["precinct"] == 76


def test_safety_carries_a_citywide_crime_percentile(empire_state):
    # Precinct 14 (Midtown South, Empire State's own precinct) is a
    # genuinely high-crime-volume precinct -- live-verified 2026-07-15
    # against the real citywide distribution (see test_citywide.py's own
    # discriminating regression guard for the exact numbers). Crime is now
    # relative-to-NYC (VISUAL.md §5), never an absolute count on its own.
    s = empire_state["safety"]
    assert isinstance(s["crime_percentile"], float)
    assert s["crime_percentile"] > 90


def test_carroll_gardens_reads_as_lower_crime_than_empire_state(empire_state):
    cg = profile.profile_for("360 Smith St, Brooklyn")
    assert cg["safety"]["crime_percentile"] < empire_state["safety"]["crime_percentile"]
    assert cg["safety"]["crime_percentile"] < 10


def test_has_the_new_blocks(empire_state):
    assert {"quiet", "green", "building"} <= set(empire_state)


def test_quiet_block_shape(empire_state):
    q = empire_state["quiet"]
    assert isinstance(q["noise_complaints_12mo"], int)
    assert q["noise_complaints_12mo"] > 0
    assert q["source"] == {
        "name": "NYC 311",
        "url": "https://data.cityofnewyork.us/d/erm2-nwe9",
    }


def test_green_block_shape(empire_state):
    g = empire_state["green"]
    assert isinstance(g["street_trees_nearby"], int)
    assert g["source"] == {
        "name": "NYC Street Tree Census",
        "url": "https://data.cityofnewyork.us/d/uvpi-gqnh",
    }


def test_building_block_for_empire_state(empire_state):
    b = empire_state["building"]
    assert b["year_built"] == 1931
    assert b["era"] == "prewar"
    assert "rent-stabilised" in b["era_note"]
    assert b["hpd_open_violations"]["class_c"] >= 0
    assert b["source"] == {
        "name": "NYC PLUTO + HPD",
        "url": "https://data.cityofnewyork.us/d/wvxf-dwi5",
    }


def test_building_year_built_is_never_a_bare_zero(empire_state):
    # PLUTO's yearbuilt=0 "not recorded" sentinel must never leak through
    # as a literal year -- it has to become None.
    assert empire_state["building"]["year_built"] != 0


# --- Phase 3: bedbugs, rodents, heat, flood -- wired into profile_for() ---

# Real fixture addresses re-used from each source module's own test file
# (tests/test_bedbugs.py, test_rodents.py, test_heat.py, test_flood.py),
# geocoded here live to confirm profile_for()'s own address -> BBL path
# lands on the exact same BBL those source-level tests already verified
# live -- see this dispatch's own agent-report for the confirmed geocode
# results (all four matched exactly, no drift).


@pytest.fixture(scope="module")
def bedbug_building():
    # 60 West 36 St, Manhattan -- BBL 1008370078, matches bedbugs.py's own
    # KNOWN_BBL fixture (six filings on record, most recent 135 total
    # units / 9 infested / 0 eradicated / 2 re-infested).
    return profile.profile_for("60 West 36 St, Manhattan")


@pytest.fixture(scope="module")
def rat_building():
    # 346 East 4 St, Manhattan -- BBL 1003730026, matches rodents.py's own
    # KNOWN_BBL fixture (4 real Initial/Compliance inspections, 3 failed).
    return profile.profile_for("346 East 4 St, Manhattan")


@pytest.fixture(scope="module")
def heat_hotspot():
    # 1040B East 217 St, Bronx -- BBL 2046990051, matches heat.py's own
    # KNOWN_HEAT_BBL fixture: the single worst building in the city for
    # heat/hot-water 311 complaints in the 2025-26 heating season (2,401).
    return profile.profile_for("1040B East 217 St, Bronx")


@pytest.fixture(scope="module")
def flood_zone_building():
    # 480 Van Brunt St, Brooklyn (Red Hook waterfront, ex-Fairway Market
    # site) -- confirmed live 2026-07-17: geocodes to (40.6742,
    # -74.017051), a real point inside FEMA's Zone AE Special Flood
    # Hazard Area (in_special_flood_hazard_area=True, BFE 10.0ft), the
    # same zone test_flood.py's own RED_HOOK_POINT fixture lands in.
    return profile.profile_for("480 Van Brunt St, Brooklyn")


def test_has_the_hazard_blocks(empire_state):
    assert {"bedbugs", "rodents", "heat", "flood"} <= set(empire_state)


def test_bedbugs_real_filing(bedbug_building):
    r = bedbug_building["bedbugs"]["report"]
    assert r["units_total"] == 135
    assert r["units_infested"] == 9
    assert r["units_reinfested"] == 2
    assert r["filing_period_end"] == "2025-10-31"
    assert bedbug_building["bedbugs"]["source"] == {
        "name": "NYC Bedbug Filings",
        "url": "https://data.cityofnewyork.us/d/wz6d-d3jb",
    }


def test_bedbugs_none_means_never_filed_not_zero(empire_state):
    # Empire State's own BBL has never filed a bedbug report (confirmed
    # live) -- this must come back as None, not a dict of zeros, which
    # would falsely claim a clean filing history that doesn't exist.
    assert empire_state["bedbugs"]["report"] is None
    # The source is still attached even when there's nothing to report --
    # a real lookup ran and found nothing, so the citation still applies.
    assert empire_state["bedbugs"]["source"]["name"]


def test_rodents_real_inspection_failures(rat_building):
    r = rat_building["rodents"]["inspections"]
    assert r["inspections"] == 4
    assert r["failed"] == 3
    assert r["last_result"] == "Failed for Rat Activity"
    assert rat_building["rodents"]["source"] == {
        "name": "NYC DOHMH Rodent Inspections",
        "url": "https://data.cityofnewyork.us/d/p937-wjvj",
    }


def test_rodents_none_means_never_inspected_not_zero(empire_state):
    assert empire_state["rodents"]["inspections"] is None


def test_heat_real_hotspot_complaints(heat_hotspot):
    h = heat_hotspot["heat"]
    assert h["complaints"] == 2401
    assert h["joined_on"] == "bbl"
    assert h["source"] == {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"}


def test_heat_is_a_real_low_count_not_absent(empire_state):
    # Empire State's own BBL carries a real, small, non-zero heat/hot-water
    # complaint count (confirmed live: 1) -- distinct from bedbugs/rodents
    # at the same address, which are genuinely None (never filed/inspected
    # at all). heat.complaints() always returns a dict (0 or more), never
    # None, because a BBL join always "looked" even when it finds nothing.
    h = empire_state["heat"]
    assert isinstance(h["complaints"], int)
    assert h["joined_on"] == "bbl"


def test_flood_special_hazard_area(flood_zone_building):
    f = flood_zone_building["flood"]
    assert f["zone"]["zone"] == "AE"
    assert f["zone"]["in_special_flood_hazard_area"] is True
    assert f["source"] == {
        "name": "FEMA National Flood Hazard Layer",
        "url": "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    }


def test_flood_minimal_hazard_is_not_sfha(empire_state):
    # Midtown Manhattan, inland -- Zone X, not a Special Flood Hazard Area.
    # A real, discriminating contrast against flood_zone_building's Zone AE,
    # not just "some zone came back."
    f = empire_state["flood"]
    assert f["zone"]["zone"] == "X"
    assert f["zone"]["in_special_flood_hazard_area"] is False
