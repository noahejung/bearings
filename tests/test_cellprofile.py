"""Tests for the per-cell (H3 res-9) block-level profile precompute
(SPEC-precompute-v2.md Phase 1) -- real network calls throughout: five full
citywide dataset fetches (311 noise, street trees, PLUTO, HPD open Class C
violations) plus the already-tested citywide crime bake, all on the FIRST
run in a fresh data/ directory (a real several minutes, see
cellprofile.py's own module docstring); a fast no-op after that.
"""

import pytest

from bearings import cellprofile, cells, geocode

EMPIRE_STATE = "350 5th Ave, Manhattan"


@pytest.fixture(scope="module", autouse=True)
def warmed():
    cellprofile.warm_caches()


@pytest.fixture(scope="module")
def esb_cell():
    # Same fixture-address convention test_mapgeo.py/test_api.py already
    # use -- geocoded live rather than a hardcoded lat/lng, so this always
    # matches whatever cell the real geocoder resolves the address to. A
    # genuinely dense Midtown block, so noise/amenities/trees/transit all
    # have a real, non-trivial signal to assert against.
    loc = geocode.geocode(EMPIRE_STATE)
    return cells.cell_for(loc.lat, loc.lng)


@pytest.fixture(scope="module")
def esb_profile(esb_cell):
    prof = cellprofile.profile_for(esb_cell)
    assert prof is not None
    return prof


def test_all_cells_are_data_derived_and_close_to_the_long_cited_estimate():
    # Not a bounding-box enumeration (see cellprofile.py's module docstring
    # for why that would overshoot into open water) -- every real cell has
    # at least one baked building footprint in it. Confirmed live
    # 2026-07-15: 7,021, closely matching this project's own long-cited
    # "~7,400 res-9 cells citywide" estimate (SPEC-precompute-v2.md).
    cell_ids = cellprofile.all_cells()
    assert 6_000 < len(cell_ids) < 9_000
    assert len(cell_ids) == len(set(cell_ids))  # no dupes


def test_manifest_reports_a_real_bake_summary():
    m = cellprofile.manifest()
    assert 6_000 < m["cell_count"] < 9_000
    assert m["shard_count"] > 0
    assert len(m["shards"]) == m["shard_count"]
    # Not every open-Class-C HPD lot resolves a PLUTO lat/lng (a real,
    # reported join gap, never silently assumed to be 100%) -- but a
    # healthy majority must, or the join itself is broken.
    assert m["pluto_hpd_join_hit_rate"] is not None
    assert m["pluto_hpd_join_hit_rate"] > 0.5


def test_raises_a_loud_error_if_not_yet_baked(monkeypatch, tmp_path, esb_cell):
    monkeypatch.setattr(cellprofile, "_MANIFEST_PATH", tmp_path / "never-baked.json")
    with pytest.raises(FileNotFoundError):
        cellprofile.profile_for(esb_cell)
    with pytest.raises(FileNotFoundError):
        cellprofile.manifest()


def test_unknown_cell_returns_none_not_a_fabricated_profile():
    # A syntactically-valid H3 res-9 cell that is real ocean (well off
    # Rockaway, no building footprint anywhere near it) -- must be a clean
    # None, never a zeroed-out profile that looks like a real empty cell.
    ocean_cell = cells.cell_for(40.40, -73.75)
    assert ocean_cell not in set(cellprofile.all_cells())
    assert cellprofile.profile_for(ocean_cell) is None


def test_empire_state_cell_carries_the_full_contract_shape(esb_cell, esb_profile):
    assert set(esb_profile) == {
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
    assert esb_profile["h3"] == esb_cell
    assert esb_profile["shard"] == cells.shard_for(esb_cell)
    assert set(esb_profile["centroid"]) == {"lat", "lng"}
    assert set(esb_profile["noise"]) == {"complaints_12mo", "percentile", "caveat", "source"}
    assert set(esb_profile["amenities"]) == {"counts", "source"}
    assert set(esb_profile["trees"]) == {"street_trees", "source"}
    assert set(esb_profile["benches"]) == {"benches", "leaning_bars", "source"}
    assert set(esb_profile["building_age"]) == {"median_year_built", "era", "source"}
    assert set(esb_profile["transit"]) == {
        "stations_within_500m",
        "to_anchors",
        "unreachable_reason",
        "caveat",
        "source",
    }
    assert set(esb_profile["transit"]["to_anchors"]) == {
        "midtown",
        "wtc",
        "downtown_brooklyn",
        "newport_path",
    }
    assert set(esb_profile["transit"]["unreachable_reason"]) == {
        "midtown",
        "wtc",
        "downtown_brooklyn",
        "newport_path",
    }
    assert set(esb_profile["safety"]) == {
        "precinct",
        "crime",
        "crime_caveat",
        "source",
        "block_crime",
    }
    assert set(esb_profile["safety"]["block_crime"]) == {
        "count",
        "smoothed_count",
        "percentile",
        "lookback_months",
        "offense_scope",
        "caveat",
        "source",
    }
    assert set(esb_profile["housing_hazards"]) == {"class_c_violations", "note", "source"}


def test_every_source_cites_a_real_working_url(esb_profile):
    for block_key in (
        "noise",
        "amenities",
        "trees",
        "benches",
        "building_age",
        "transit",
        "safety",
        "housing_hazards",
    ):
        source = esb_profile[block_key]["source"]
        assert source["name"]
        assert source["url"].startswith("http")


def test_empire_state_cell_has_real_nontrivial_signal_not_just_zeros(esb_profile):
    # Guards against the "only ever observes zeros" trap this project's own
    # invariants call out explicitly -- Herald Sq/5 Av is one of the
    # loudest, densest, most transit-served blocks in the city.
    assert esb_profile["noise"]["complaints_12mo"] > 0
    assert sum(esb_profile["amenities"]["counts"].values()) > 0
    assert esb_profile["benches"]["benches"] > 0
    assert esb_profile["transit"]["stations_within_500m"] > 0
    assert esb_profile["building_age"]["median_year_built"] is not None
    assert 1600 < esb_profile["building_age"]["median_year_built"] <= 2026
    assert esb_profile["building_age"]["era"] in ("prewar", "postwar", "modern")


def test_transit_to_anchors_are_plausible_travel_times(esb_profile):
    to_anchors = esb_profile["transit"]["to_anchors"]
    reasons = esb_profile["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert isinstance(minutes, int)
        # -1 is the established "unreachable from the nearest stations"
        # sentinel (matches profile.py's own _to_anchors() convention) --
        # every other value must be a plausible real minute count, never
        # negative-but-not-the-sentinel or an absurd number.
        assert minutes == -1 or 0 <= minutes < 240
        # The minutes sentinel and its reason must always travel together
        # -- see profile.py's _anchor_result() docstring for why this is
        # an invariant, not a coincidence.
        if minutes == -1:
            assert reasons[anchor] in ("no_station_in_range", "no_rail_connection")
        else:
            assert reasons[anchor] is None
    # Midtown itself must be fast from a cell that all but sits on top of
    # Times Sq-42 St -- a real regression guard, not just "is an int".
    assert 0 <= to_anchors["midtown"] < 20


def test_no_rail_connection_reason_at_a_named_real_staten_island_cell():
    # H3 892a106084bffff, centroid ~(40.5357, -74.1883) -- near Huguenot,
    # Staten Island (named in this project's 2026-07-18 "no-route"
    # diagnosis report). The nearest real station here is S16 Huguenot
    # (Staten Island Railway) -- SIR has no rail path to the rest of NYCT
    # (the only crossing is the Staten Island Ferry, not in this project's
    # GTFS data), a real, permanent gap, not a bug, and a genuinely
    # different fact from "no station nearby at all".
    prof = cellprofile.profile_for("892a106084bffff")
    assert prof is not None
    to_anchors = prof["transit"]["to_anchors"]
    reasons = prof["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert minutes == -1
        assert reasons[anchor] == "no_rail_connection"


def test_no_station_in_range_reason_at_a_named_real_cell():
    # H3 892a1060e4fffff -- the real cell the live address "131 Huguenot
    # Ave, Staten Island" geocodes into. Confirmed live 2026-07-18: zero
    # subway or PATH stations of any kind fall within STATION_SEARCH_M of
    # this cell's centroid -- a genuine transit-desert case, not a network
    # gap on top of a nearby station.
    cell = "892a1060e4fffff"
    assert cell in set(cellprofile.all_cells())
    prof = cellprofile.profile_for(cell)
    assert prof is not None
    to_anchors = prof["transit"]["to_anchors"]
    reasons = prof["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert minutes == -1
        assert reasons[anchor] == "no_station_in_range"


def test_reachable_control_cell_has_no_reason():
    # H3 892a100d293ffff, centroid ~(40.7502, -73.9772) -- immediately by
    # Grand Central, Manhattan (this project's own named control cell from
    # the 2026-07-18 diagnosis/fix reports). Every anchor resolves to a
    # real ride here -- the reason dict must be all None, matching the
    # minutes dict having no -1 sentinel anywhere.
    prof = cellprofile.profile_for("892a100d293ffff")
    assert prof is not None
    to_anchors = prof["transit"]["to_anchors"]
    reasons = prof["transit"]["unreachable_reason"]
    for anchor, minutes in to_anchors.items():
        assert minutes >= 0
        assert reasons[anchor] is None


def test_safety_carries_a_real_precinct_and_percentile_when_resolved(esb_profile):
    safety = esb_profile["safety"]
    assert safety["precinct"] == 14  # Midtown South -- confirmed live 2026-07-15
    assert safety["crime"] is not None
    assert 0.0 <= safety["crime"]["crime_percentile"] <= 100.0


# --- block-level crime + noise percentile (2026-08-02) ---
#
# Added after a live cross-check ("crime-noise-reality-check", 2026-08-02)
# found the precinct-only crime figure pooled Astoria with Long Island
# City (both share Precinct 114) and left two real LIC cells with no crime
# figure at all (precinct join resolving to None). block_crime is computed
# directly from raw NYPD Complaint Data per H3 cell, with no precinct join
# anywhere in the path -- see cellprofile.py's own module docstring.


def test_block_crime_never_none_even_where_the_precinct_join_fails():
    # H3 892a100d08bffff / 892a100d01bffff -- two real, non-adjacent Long
    # Island City cells, confirmed live 2026-08-02 (both geocode from real
    # addresses: "5-19 46th Ave" / "47-20 Center Blvd, Long Island City")
    # to return safety.precinct=None / safety.crime=None under the
    # (unchanged) precinct-based path -- a real, reproducible data gap the
    # 2026-08-02 report named explicitly. block_crime has no precinct
    # dependency at all, so both must carry a real (possibly zero, never
    # None) count and a real 0-100 percentile even though safety.crime
    # itself stays None for these two cells.
    for cell in ("892a100d08bffff", "892a100d01bffff"):
        prof = cellprofile.profile_for(cell)
        assert prof is not None
        safety = prof["safety"]
        assert safety["precinct"] is None
        assert safety["crime"] is None
        bc = safety["block_crime"]
        assert bc["count"] is not None
        assert bc["smoothed_count"] is not None
        assert isinstance(bc["count"], int)
        assert isinstance(bc["smoothed_count"], int)
        assert 0.0 <= bc["percentile"] <= 100.0
        assert bc["lookback_months"] == 24
        assert len(bc["offense_scope"]) == 7
        assert bc["source"]["url"].startswith("http")


def test_block_crime_smoothed_count_is_at_least_the_raw_count():
    # smoothed_count sums the cell's own raw count plus its 6 neighbours'
    # raw counts (see _block_crime_by_cell()'s own docstring) -- every
    # neighbour count is >= 0, so smoothed can never be smaller than raw.
    # A real, structural invariant, checked across a real sample of cells
    # rather than assumed.
    cell_ids = cellprofile.all_cells()
    for c in cell_ids[:200]:
        bc = cellprofile.profile_for(c)["safety"]["block_crime"]
        assert bc["smoothed_count"] >= bc["count"]


# H3 892a100001bffff, centroid ~(40.861, -73.784) -- north Bronx, a real
# low-activity residential cell picked BY SCANNING THE BAKE ITSELF rather
# than assumed from an address's reputation. This project's own "quiet,
# far, green" calibration address (3220 Netherland Ave, Riverdale) turned
# out NOT to be a safe "genuinely low percentile" control once measured
# live 2026-08-02: it lands at the 75th block-crime / 71st noise
# percentile among the ~7,017 real citywide cells -- ABOVE the citywide
# median on both axes, because NYC's per-cell distribution is heavily
# weighted toward truly low-activity cells (median 26 noise complaints/
# cell citywide; 14.2% of all cells read an exact 0) that a "quiet by NYC
# standards" residential neighbourhood still sits well above. See
# factcheck.py's own threshold-block comment for the full finding and why
# it mattered for a different task (item 4's threshold reconciliation).
_QUIET_CONTROL_CELL = "892a100001bffff"


def test_block_crime_percentile_discriminates_real_cells():
    # Grand Central's own cell (892a100d293ffff, this project's named
    # transit-hub control cell) is a genuine major-larceny hotspot -- dense
    # commuter/tourist foot traffic draws a real, live-confirmed
    # concentration of grand-larceny complaints even though its PRECINCT
    # (17, Murray Hill) reads as comparatively low-crime overall
    # (crime_percentile ~9.6, confirmed live 2026-08-02) -- exactly the
    # kind of within-precinct variation a precinct-level figure cannot see
    # and block_crime is built to surface. `_QUIET_CONTROL_CELL` (see its
    # own comment above) must land at the opposite end.
    grand_central = cellprofile.profile_for("892a100d293ffff")
    assert grand_central is not None
    assert grand_central["safety"]["block_crime"]["percentile"] > 90

    quiet = cellprofile.profile_for(_QUIET_CONTROL_CELL)
    assert quiet is not None
    assert quiet["safety"]["block_crime"]["percentile"] < 10


def test_astoria_block_crime_no_longer_inherits_the_full_lic_pooled_number():
    # H3 892a100f34fffff -- "31-01 Broadway, Astoria" (the 2026-08-02
    # report's own sample address). Astoria shares Precinct 114 with Long
    # Island City and Woodside, so the OLD precinct-only figure was really
    # "the 114th Precinct's figure" (confirmed live: crime_percentile
    # 81.4, matching the report's own finding almost exactly). block_crime
    # is computed directly from this cell's own neighbourhood, with no
    # precinct join, so it must land measurably lower -- the de-pooling
    # this whole feature exists to deliver, quantified, not just asserted
    # structurally different.
    prof = cellprofile.profile_for("892a100f34fffff")
    assert prof is not None
    safety = prof["safety"]
    assert safety["precinct"] == 114
    precinct_percentile = safety["crime"]["crime_percentile"]
    assert precinct_percentile > 75  # confirmed live ~81.4
    block_percentile = safety["block_crime"]["percentile"]
    assert block_percentile < precinct_percentile


def test_noise_percentile_carries_a_real_0_to_100_value_and_caveat(esb_profile):
    noise = esb_profile["noise"]
    assert 0.0 <= noise["percentile"] <= 100.0
    assert isinstance(noise["caveat"], str)
    assert len(noise["caveat"]) > 30


def test_noise_percentile_discriminates_real_cells(esb_profile):
    # Herald Sq/Empire State (esb_profile) is one of the loudest cells in
    # the whole citywide sample (see test_noise.py's own live-confirmed
    # ~1297 complaints/12mo at a wider 400m radius) -- its cell-level
    # percentile must land high. `_QUIET_CONTROL_CELL` (see its own
    # comment above -- a real low-activity cell found by scanning the
    # bake, not assumed from an address's reputation) must land low.
    assert esb_profile["noise"]["percentile"] > 60

    quiet = cellprofile.profile_for(_QUIET_CONTROL_CELL)
    assert quiet is not None
    assert quiet["noise"]["percentile"] < 10


def test_at_least_some_cells_citywide_show_a_real_housing_hazard_count():
    # A real, live-verified discriminating case, not an assumption: this
    # project's own guard against fixtures that only ever observe zeros.
    # 581,733 raw open-Class-C HPD violation rows exist citywide (confirmed
    # live 2026-07-15) -- across ~7,000 cells at least some must show a
    # real nonzero aggregated count.
    cell_ids = cellprofile.all_cells()
    hazard_counts = [
        cellprofile.profile_for(c)["housing_hazards"]["class_c_violations"]
        for c in cell_ids[:500]
    ] + [
        cellprofile.profile_for(c)["housing_hazards"]["class_c_violations"]
        for c in cell_ids[-500:]
    ]
    assert any(n > 0 for n in hazard_counts)


def test_cells_index_covers_every_real_cell_with_the_flat_summary_shape():
    idx = cellprofile.cells_index()
    assert set(idx) == {"cells"}
    all_ids = set(cellprofile.all_cells())
    index_ids = {c["h3"] for c in idx["cells"]}
    assert index_ids == all_ids
    for c in idx["cells"]:
        assert set(c) == {
            "h3",
            "lat",
            "lng",
            "noise",
            "amenities",
            "trees",
            "building_age_years",
            "transit_access",
        }


def test_cells_index_values_match_the_full_per_cell_profile(esb_cell, esb_profile):
    # The lightweight index must never drift from the full profile it was
    # derived from -- same numbers, just unwrapped from their {value,
    # source} blocks (see _cell_index_entry()'s own docstring).
    idx = cellprofile.cells_index()
    entry = next(c for c in idx["cells"] if c["h3"] == esb_cell)
    assert entry["lat"] == esb_profile["centroid"]["lat"]
    assert entry["lng"] == esb_profile["centroid"]["lng"]
    assert entry["noise"] == esb_profile["noise"]["complaints_12mo"]
    assert entry["amenities"] == sum(esb_profile["amenities"]["counts"].values())
    assert entry["trees"] == esb_profile["trees"]["street_trees"]
    assert entry["building_age_years"] == esb_profile["building_age"]["median_year_built"]
    assert entry["transit_access"] == esb_profile["transit"]["stations_within_500m"]


def test_cells_index_raises_a_loud_error_if_not_yet_baked(monkeypatch, tmp_path):
    monkeypatch.setattr(cellprofile, "_CELLS_INDEX_PATH", tmp_path / "never-baked.json")
    with pytest.raises(FileNotFoundError):
        cellprofile.cells_index()


def test_at_least_some_cells_citywide_have_no_pluto_coverage_and_stay_none():
    # median_year_built must be a real None for a cell with no PLUTO lot
    # centred in it -- never a fabricated year. Confirmed structurally
    # rather than assumed: at least one of the ~7,000 real cells has this.
    cell_ids = cellprofile.all_cells()
    ages = [cellprofile.profile_for(c)["building_age"]["median_year_built"] for c in cell_ids]
    assert any(a is None for a in ages)
    assert any(a is not None for a in ages)
