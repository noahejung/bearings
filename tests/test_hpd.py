import pytest

from bearings.sources import hpd

# 22 Stagg Street, Brooklyn -- boroid=3, block=3031, lot=15. Confirmed live
# 2026-07-13 to carry open violations in all three tracked classes
# (class A: 7 open, class B: 8 open, class C: 1 open), so it exercises every
# branch. Also used as the PLUTO fixture (same building, same BBL).
KNOWN_BBL = "3030310015"

# Borough 3 (Brooklyn), an implausible block/lot -- no matching rows,
# exercises the empty-DataFrame path.
NO_VIOLATIONS_BBL = "3999999999"


def test_returns_the_three_class_counts():
    d = hpd.open_violations(KNOWN_BBL)
    assert set(d) == {"class_a", "class_b", "class_c"}
    assert all(isinstance(v, int) for v in d.values())


def test_known_building_has_open_violations_in_every_class():
    d = hpd.open_violations(KNOWN_BBL)
    assert d["class_a"] > 0
    assert d["class_b"] > 0
    assert d["class_c"] > 0


def test_nonexistent_lot_has_no_violations():
    assert hpd.open_violations(NO_VIOLATIONS_BBL) == {
        "class_a": 0,
        "class_b": 0,
        "class_c": 0,
    }


def test_bbl_parts_splits_borough_block_lot():
    # A BBL is borough(1) + block(5, zero-padded) + lot(4, zero-padded).
    # HPD's own block/lot columns are un-padded, so the padding must come
    # back off before joining.
    assert hpd._bbl_parts("3030310015") == ("3", "3031", "15")
    assert hpd._bbl_parts("1008350041") == ("1", "835", "41")


def test_exposes_its_source():
    assert hpd.SOURCE["name"] == "NYC HPD"
    assert "wvxf-dwi5" in hpd.SOURCE["url"]
