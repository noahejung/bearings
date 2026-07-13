import pytest

from bearings.sources import rodents

# 346 East 4 St, Manhattan -- boro=1, block=373, lot=26. Confirmed live
# 2026-07-13: 4 real Initial/Compliance inspections in the trailing 24
# months, 3 of them failed (2026-06-06, 2025-12-06, 2024-12-27), 1 passed
# (2025-06-10). Most recent is a fail, so inspections != failed and
# last_result reflects the true most recent record -- exercises every branch.
KNOWN_BBL = "1003730026"

# Borough 3 (Brooklyn), an implausible block/lot -- same fixture pattern as
# HPD/bedbugs. Confirmed live: zero rows.
NEVER_INSPECTED_BBL = "3999999999"


def test_known_building_inspection_summary():
    d = rodents.inspections(KNOWN_BBL)
    assert d["inspections"] == 4
    assert d["failed"] == 3
    assert d["last_result"] == "Failed for Rat Activity"
    assert d["last_date"] == "2026-06-06"


def test_never_inspected_returns_none_not_zero():
    # None means "never inspected" -- a different fact from "inspected and
    # passed every time," which would be a real dict with inspections > 0
    # and failed == 0.
    assert rodents.inspections(NEVER_INSPECTED_BBL) is None


def test_bbl_parts_splits_borough_block_lot():
    assert rodents._bbl_parts("1003730026") == ("1", "373", "26")
    assert rodents._bbl_parts("3030310015") == ("3", "3031", "15")


def test_exposes_its_source():
    assert rodents.SOURCE["name"]
    assert "p937-wjvj" in rodents.SOURCE["url"]
