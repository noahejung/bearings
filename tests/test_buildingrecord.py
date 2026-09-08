"""Per-building record: the bake, the lookup, and the three-state shape.

Live data, no mocking, per this project's own rule -- with one deliberate
exception that is not a mock: the "live source is down" state is produced by
monkeypatching the *source module's own function* to raise the same exception
class the real network failure raises. There is no way to make FEMA or
Socrata fail on demand, and a state that is never exercised is a state that
is never tested; forcing the failure at the seam is the honest way to reach
it. Every non-failure assertion below runs against the real live/baked data.
"""

import time
from datetime import datetime

import pytest

from bearings import buildingrecord, config
from bearings.sources import buildings, flood, pavement, rodents, socrata

# 60 West 36 St, Manhattan (Midtown) -- tests/test_bedbugs.py's own fixture.
# Confirmed live 2026-07-13 and re-confirmed 2026-09-07: six bedbug filings on
# record, most recent covering the period ending 2025-10-31 (135 units, 9
# infested, 2 re-infested, 0 eradicated). No rodent inspections in the
# trailing 24 months.
BEDBUG_BBL = "1008370078"

# 346 East 4 St, Manhattan -- tests/test_rodents.py's own fixture. Confirmed
# live: 4 real Initial/Compliance inspections in the trailing 24 months, 3
# failed, most recent 2026-06-06 "Failed for Rat Activity".
#
# NOTE, found by measurement while writing this file (not assumed): this real
# building has NO row in the baked footprint file at all -- `SELECT ... FROM
# buildings.parquet WHERE bbl='1003730026'` returns zero rows, while
# building_attributes.parquet (PLUTO) does carry the lot. So this BBL is also
# the fixture for "the point-derivation guard fires", below.
RODENT_BBL = "1003730026"

# 1040B East 217 St, Bronx -- tests/test_heat.py's own fixture. 2,401
# HEAT/HOT WATER 311 complaints in the closed 2025-10-01..2026-05-31 heating
# season, the worst building in the city that season. The season is closed,
# so this number cannot drift on a re-run.
HEAT_BBL = "2046990051"

# 161 Newel St, Greenpoint, Brooklyn -- a real, ordinary rowhouse-scale
# building, taken from the first page of the live bedbug dataset (2026-09-07
# probe). Confirmed live: 3 rodent inspections in the trailing 24 months, 2
# failed, most recent 2026-01-30 "Passed"; a real baked footprint.
BROOKLYN_BBL = "3026230011"

# 1 Wall St, Manhattan -- a real Manhattan tower with a real baked footprint,
# used for the "everything resolves, nothing is unavailable" latency case.
# Confirmed live 2026-09-07 from its own derived point (40.70823, -74.01052):
# FEMA Zone X (minimal hazard), DOT 25 rated segments averaging 7.65.
WALL_ST_BBL = "1000470001"

# Beard St / Red Hook, Brooklyn. NOT guessed -- resolved 2026-09-07 by asking
# the baked footprint file which footprint's own bbox contains
# tests/test_flood.py's RED_HOOK_POINT (40.6742, -74.0114); exactly one does,
# and it is this BBL. Zone AE, the Special Flood Hazard Area case.
RED_HOOK_BBL = "3005990122"


def test_baked_file_exists_and_carries_the_columns_the_reader_asks_for():
    # warm_cache() is a no-op once baked; this is the same guard api.py's
    # startup handler runs, so a schema drift fails loudly here too.
    buildingrecord.warm_cache()
    assert buildingrecord._PATH.exists()
    assert buildingrecord._META_PATH.exists()


def test_bake_meta_records_the_windows_the_numbers_were_counted_over():
    meta = buildingrecord.bake_meta()
    assert meta["baked_at"]
    assert meta["heat"]["season_start"] and meta["heat"]["season_end"]
    assert meta["heat"]["seasons"] == buildingrecord.HEAT_SEASONS
    # The heating-season count is the honest denominator behind every
    # heat_complaints number in the file -- a number with no stated window
    # is not a fact.
    assert meta["bedbugs"]["bbls"] > 100_000
    assert meta["heat"]["bbls"] > 10_000


# --------------------------------------------------------------------------
# The baked half -- bedbugs and heat.
# --------------------------------------------------------------------------


def test_bedbugs_value_state_matches_the_live_source_exactly():
    rec = buildingrecord.record_for(BEDBUG_BBL)
    assert rec["bedbugs"] == {
        "filings": 6,
        "period_end": "2025-10-31",
        "units_total": 135,
        "units_infested": 9,
        "units_reinfested": 2,
        "units_eradicated": 0,
    }


def test_bedbugs_no_record_state_is_null_not_a_dict_of_zeros():
    # A building that has never filed a bedbug report. `None` means "no
    # record"; a dict of zeros would silently claim a filed, clean report.
    rec = buildingrecord.record_for(HEAT_BBL)
    assert rec["bedbugs"] is None


def test_heat_is_a_real_count_never_null_because_the_whole_season_was_baked():
    rec = buildingrecord.record_for(HEAT_BBL)
    assert rec["heat"]["complaints"] == 2401
    assert rec["heat"]["season_start"] == "2025-10-01"
    assert rec["heat"]["season_end"] == "2026-06-01"


def test_heat_zero_means_we_looked_citywide_and_found_none():
    # The bake covers the whole city for the whole season, so a BBL that is
    # absent from it has a real, measured zero -- not a missing value. This
    # is the one field in this endpoint that is never `null`, and that is a
    # statement about what the bake knows, not a coercion.
    rec = buildingrecord.record_for(BEDBUG_BBL)
    assert rec["heat"]["complaints"] == 0
    assert rec["heat"]["caveat"]


def test_heat_caveat_names_the_311_rows_that_carry_no_bbl():
    # ~0.35% of heat complaints in the season carry a null bbl (311's own
    # geocoding gap) and cannot be attributed to any building. Stating it is
    # the difference between a number and a claim.
    assert "bbl" in buildingrecord.HEAT_CAVEAT or "geocod" in buildingrecord.HEAT_CAVEAT


def test_baked_lookup_is_fast_enough_to_be_on_the_request_path():
    buildingrecord._baked_row.cache_clear()
    start = time.monotonic()
    row = buildingrecord._baked_row(HEAT_BBL)
    elapsed = time.monotonic() - start
    assert row is not None
    # The spec's own target for the baked half of this endpoint is 50ms.
    # Generous ceiling here so a cold OS page cache doesn't produce a
    # flaky failure -- this asserts "a lookup, not a scan-and-compute".
    assert elapsed < 0.5, f"baked lookup took {elapsed:.3f}s"


# --------------------------------------------------------------------------
# The live half -- rodents, flood, pavement -- and the three states.
# --------------------------------------------------------------------------


def test_rodents_value_state_matches_the_live_source_exactly():
    rec = buildingrecord.record_for(RODENT_BBL)
    assert rec["rodents"] == {
        "inspections": 4,
        "failed": 3,
        "last_result": "Failed for Rat Activity",
        "last_date": "2026-06-06",
        "months": rodents_months(),
    }


def rodents_months() -> int:
    return buildingrecord.RODENT_MONTHS


def test_rodents_no_record_state_is_null_not_zero_inspections():
    rec = buildingrecord.record_for(BEDBUG_BBL)
    assert rec["rodents"] is None


def test_rodents_unavailable_state_when_the_live_source_fails(monkeypatch):
    def boom(*_a, **_kw):
        raise socrata.httpx.ReadTimeout("forced -- see this module's docstring")

    buildingrecord._rodents_for_bbl.cache_clear()
    monkeypatch.setattr(rodents, "inspections", boom)
    rec = buildingrecord.record_for(RODENT_BBL)
    assert rec["rodents"]["unavailable"] is True
    assert rec["rodents"]["reason"]
    # Never conflated with "no record": a caller must be able to tell
    # "we asked and the answer is none" from "we could not ask".
    assert rec["rodents"] != {}


def test_flood_value_state_is_a_real_fema_zone():
    # Red Hook, Brooklyn -- confirmed live Zone AE. Resolved here from the
    # BBL's own baked footprint point, not from a hand-passed lat/lng.
    rec = buildingrecord.record_for(RED_HOOK_BBL)
    assert rec["flood"]["zone"] == "AE"
    assert rec["flood"]["in_special_flood_hazard_area"] is True


def test_flood_unavailable_state_when_fema_fails(monkeypatch):
    def boom(*_a, **_kw):
        raise flood.httpx.ConnectError("forced -- see this module's docstring")

    buildingrecord._flood_for_point.cache_clear()
    monkeypatch.setattr(flood, "zone", boom)
    rec = buildingrecord.record_for(WALL_ST_BBL)
    assert rec["flood"]["unavailable"] is True
    assert rec["flood"]["reason"]


def test_pavement_value_state_is_a_real_dot_rating():
    rec = buildingrecord.record_for(WALL_ST_BBL)
    assert rec["pavement"]["segments_rated"] > 0
    assert 1.0 <= rec["pavement"]["average_rating"] <= 10.0


def test_pavement_unavailable_state_when_socrata_fails(monkeypatch):
    def boom(*_a, **_kw):
        raise socrata.httpx.ReadTimeout("forced -- see this module's docstring")

    buildingrecord._pavement_for_point.cache_clear()
    monkeypatch.setattr(pavement, "near", boom)
    rec = buildingrecord.record_for(WALL_ST_BBL)
    assert rec["pavement"]["unavailable"] is True
    assert rec["pavement"]["reason"]


# --------------------------------------------------------------------------
# The point-derivation guard: no plausible-but-wrong point, ever.
# --------------------------------------------------------------------------


def test_a_bbl_with_no_baked_footprint_cannot_be_flood_or_pavement_looked_up():
    # RODENT_BBL is a real Manhattan building with real rodent inspections
    # and a real PLUTO lot, but no row in the baked footprint file -- so
    # there is no point to hand FEMA or DOT. That is "we could not ask",
    # not "we asked and the answer is none".
    assert buildings.point_for_bbl(RODENT_BBL) is None
    rec = buildingrecord.record_for(RODENT_BBL)
    assert rec["point"] is None
    assert rec["flood"]["unavailable"] is True
    assert rec["pavement"]["unavailable"] is True
    # ...while the BBL-keyed fields still answer normally.
    assert rec["rodents"]["inspections"] == 4


def test_a_sentinel_bbl_shared_by_scattered_footprints_is_refused_not_averaged():
    # base_bbl '3999999999' (borough 3, block 99999, lot 9999) is DOB's own
    # unknown-lot placeholder: 23 unrelated footprints citywide carry it,
    # spanning 0.16 degrees of latitude (~18 km, confirmed live against the
    # baked file 2026-09-07). A centroid over that group would be a
    # perfectly-computed, completely-wrong point -- the exact shape of the
    # 2.3 km subway-anchor snap this codebase's AnchorSnapTooFar guard
    # exists to prevent. Refuse it.
    assert buildings.point_for_bbl("3999999999") is None
    rec = buildingrecord.record_for("3999999999")
    assert rec["point"] is None
    assert "spread" in rec["flood"]["reason"] or "footprint" in rec["flood"]["reason"]


def test_a_normal_bbl_resolves_to_a_point_inside_its_own_footprint():
    pt = buildings.point_for_bbl(BROOKLYN_BBL)
    assert pt is not None
    lat, lng = pt
    # 161 Newel St, Greenpoint -- the bedbug dataset's own published
    # latitude/longitude for this building is (40.727680, -73.949030).
    assert abs(lat - 40.72768) < 0.001
    assert abs(lng - (-73.94903)) < 0.001


# --------------------------------------------------------------------------
# Shape, sourcing, and malformed input.
# --------------------------------------------------------------------------


def test_every_top_level_key_is_always_present_even_when_every_source_is_empty():
    rec = buildingrecord.record_for(BEDBUG_BBL)
    assert set(rec) == {
        "bbl",
        "point",
        "bedbugs",
        "rodents",
        "heat",
        "flood",
        "pavement",
        "sources",
    }


def test_every_field_carries_a_real_source_with_a_working_url_and_an_as_of():
    rec = buildingrecord.record_for(BROOKLYN_BBL)
    for key in ("bedbugs", "rodents", "heat", "flood", "pavement"):
        src = rec["sources"][key]
        assert src["name"], key
        assert src["url"].startswith("https://"), key
        assert src["as_of"], key


def test_baked_and_live_sources_declare_which_they_are():
    rec = buildingrecord.record_for(BROOKLYN_BBL)
    assert rec["sources"]["bedbugs"]["baked"] is True
    assert rec["sources"]["heat"]["baked"] is True
    assert rec["sources"]["rodents"]["baked"] is False
    assert rec["sources"]["flood"]["baked"] is False
    assert rec["sources"]["pavement"]["baked"] is False


def test_malformed_bbls_are_rejected_not_silently_answered():
    for bad in ("", "123", "abcdefghij", "9008350041", "1008350041x", "10083500411"):
        assert not buildingrecord.is_wellformed_bbl(bad), bad
    for good in ("1008370078", "3026230011", "5028290070"):
        assert buildingrecord.is_wellformed_bbl(good), good


def test_the_whole_record_stays_inside_its_own_latency_budget():
    # The three live sources run in parallel against one shared deadline, so
    # the endpoint's wall clock is bounded by the slowest single source, not
    # by their sum. Cold cache, real network.
    buildingrecord._rodents_for_bbl.cache_clear()
    buildingrecord._flood_for_point.cache_clear()
    buildingrecord._pavement_for_point.cache_clear()
    start = time.monotonic()
    buildingrecord.record_for(WALL_ST_BBL)
    elapsed = time.monotonic() - start
    assert elapsed < buildingrecord.LIVE_DEADLINE_S + 1.0, f"{elapsed:.2f}s"


def test_a_hung_live_source_releases_the_response_at_the_deadline(monkeypatch):
    # REGRESSION, found by measurement 2026-09-07 rather than by reading the
    # code: the first version of _live_blocks() used
    # `with ThreadPoolExecutor(...)`, whose __exit__ calls shutdown(wait=True)
    # and joins every submitted thread. The deadline fired correctly and
    # every live field said "did not answer within 3.5s" -- and then the
    # response sat there for the full 10s the forced hang lasted anyway. A
    # guard that fires but does not release is not a guard.
    def hang(*_a, **_kw):
        time.sleep(10)

    buildingrecord._rodents_for_bbl.cache_clear()
    buildingrecord._flood_for_point.cache_clear()
    buildingrecord._pavement_for_point.cache_clear()
    monkeypatch.setattr(rodents, "inspections", hang)
    monkeypatch.setattr(flood, "zone", hang)
    monkeypatch.setattr(pavement, "near", hang)

    start = time.monotonic()
    rec = buildingrecord.record_for(WALL_ST_BBL)
    elapsed = time.monotonic() - start

    assert rec["rodents"]["unavailable"] is True
    assert rec["flood"]["unavailable"] is True
    assert rec["pavement"]["unavailable"] is True
    # The baked half still answered, which is the other half of the point:
    # a slow live source must never block a number already on disk.
    assert rec["heat"]["complaints"] is not None
    assert elapsed < buildingrecord.LIVE_DEADLINE_S + 1.5, (
        f"deadline fired but the response still took {elapsed:.2f}s"
    )


def test_the_baked_schema_guard_is_wired_and_loud(tmp_path, monkeypatch):
    import pandas as pd

    stale = tmp_path / "building_hazards.parquet"
    buildings._write_parquet(pd.DataFrame({"bbl": ["1008370078"]}), stale)
    monkeypatch.setattr(buildingrecord, "_PATH", stale)
    monkeypatch.setattr(buildingrecord, "_META_PATH", tmp_path / "building_hazards.json")
    with pytest.raises(Exception) as exc:
        buildingrecord.warm_cache()
    assert "building_hazards" in str(exc.value) or "older version" in str(exc.value)


def test_freshness_window_is_configured_and_warns_when_crossed(tmp_path, monkeypatch):
    import os

    import pandas as pd

    path = tmp_path / "building_hazards.parquet"
    frame = pd.DataFrame(
        {c: pd.Series(dtype="object") for c in sorted(buildingrecord.BAKED_COLUMNS)}
    )
    buildings._write_parquet(frame, path)
    old = time.time() - (config.BUILDING_HAZARDS_CACHE_MAX_AGE_S + 86400)
    os.utime(path, (old, old))
    monkeypatch.setattr(buildingrecord, "_PATH", path)
    monkeypatch.setattr(buildingrecord, "_META_PATH", tmp_path / "building_hazards.json")
    (tmp_path / "building_hazards.json").write_text("{}")
    with pytest.warns(Warning, match="building hazards"):
        buildingrecord.warm_cache()


# --------------------------------------------------------------------------
# The dates this endpoint hands a reader are New York dates.
# --------------------------------------------------------------------------


def test_a_new_york_evening_is_already_tomorrow_in_utc():
    """The bug, pinned to the exact instant it was observed at. 21:38 on
    2026-09-07 in New York is 01:38 on 2026-09-08 in UTC, so a UTC-formatted
    calendar day labels that evening's live lookups with a day that has not
    started yet for anyone reading them. Clock-independent: it asserts the
    conversion, not the current time."""
    from datetime import timezone
    from zoneinfo import ZoneInfo

    from bearings import config

    instant = datetime(2026, 9, 8, 1, 38, tzinfo=timezone.utc)
    assert instant.strftime("%Y-%m-%d") == "2026-09-08"
    assert instant.astimezone(ZoneInfo(config.PROJECT_TZ)).strftime("%Y-%m-%d") == "2026-09-07"


def test_today_is_the_new_york_date():
    from datetime import timezone
    from zoneinfo import ZoneInfo

    from bearings import config

    new_york = datetime.now(ZoneInfo(config.PROJECT_TZ)).strftime("%Y-%m-%d")
    utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    assert buildingrecord._today() == new_york
    if new_york != utc:
        # Only reachable during the hours the two disagree, which is exactly
        # the window this exists for -- so it is asserted when it can be.
        assert buildingrecord._today() != utc


def test_live_sources_are_dated_in_new_york_not_utc():
    from zoneinfo import ZoneInfo

    from bearings import config

    new_york = datetime.now(ZoneInfo(config.PROJECT_TZ)).strftime("%Y-%m-%d")
    rec = buildingrecord.record_for(BROOKLYN_BBL)
    for key, src in rec["sources"].items():
        if not src["baked"]:
            assert src["as_of"] == new_york, key


def test_the_photo_endpoints_as_of_is_a_new_york_date_too():
    from zoneinfo import ZoneInfo

    from bearings import config

    new_york = datetime.now(ZoneInfo(config.PROJECT_TZ)).strftime("%Y-%m-%d")
    assert buildingrecord.photo_for(BROOKLYN_BBL)["source"]["as_of"] == new_york
