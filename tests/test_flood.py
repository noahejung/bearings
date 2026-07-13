from bearings.sources import flood

# Beard St, Red Hook, Brooklyn -- one block off the waterfront, an area
# that flooded badly in Hurricane Sandy. Confirmed live 2026-07-13 against
# the FEMA NFHL "Flood Hazard Zones" layer: FLD_ZONE="AE" (Special Flood
# Hazard Area, 1% annual chance flood, Base Flood Elevation determined),
# SFHA_TF="T", STATIC_BFE=10.0 ft.
RED_HOOK_POINT = (40.6742, -74.0114)

# Times Sq-42 St, Manhattan -- inland, nowhere near a waterway. Confirmed
# live 2026-07-13: FLD_ZONE="X", ZONE_SUBTY="AREA OF MINIMAL FLOOD HAZARD",
# SFHA_TF="F", STATIC_BFE=-9999.0 (FEMA's "not applicable" sentinel for
# this field, not a real elevation).
TIMES_SQUARE_POINT = (40.7549, -73.9840)

# Open Atlantic, ~370 miles offshore -- well outside any FEMA Flood
# Insurance Study, so the NFHL query returns zero features. Confirmed live
# 2026-07-13.
OFFSHORE_POINT = (40.0, -70.0)


def test_special_flood_hazard_area():
    r = flood.zone(*RED_HOOK_POINT)
    assert r["zone"] == "AE"
    assert r["in_special_flood_hazard_area"] is True
    assert "1%" in r["description"] or "base flood" in r["description"].lower()


def test_minimal_hazard_area_is_not_sfha():
    r = flood.zone(*TIMES_SQUARE_POINT)
    assert r["zone"] == "X"
    assert r["in_special_flood_hazard_area"] is False


def test_no_coverage_point_returns_none():
    # None means "no NFHL study covers this point" -- a different fact
    # from "studied and found minimal hazard" (Zone X), which is a real
    # dict with in_special_flood_hazard_area == False.
    assert flood.zone(*OFFSHORE_POINT) is None


def test_exposes_its_source():
    assert flood.SOURCE["name"]
    assert "hazards.fema.gov" in flood.SOURCE["url"]
    assert "NFHL" in flood.SOURCE["url"]
