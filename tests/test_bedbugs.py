import pytest

from bearings.sources import bedbugs

# 60 West 36 St, Manhattan (Midtown). Confirmed live 2026-07-13: six filings
# on record for this BBL, most recent filed 2026-05-28 for the 2024-11-01 to
# 2025-10-31 period -- 135 total units, 9 infested, 0 eradicated, 2
# re-infested. All four numbers are distinct, so this fixture catches a
# field-order mix-up, not just a "some number came back" false pass.
KNOWN_BBL = "1008370078"

# Borough 3 (Brooklyn), an implausible block/lot -- same fixture pattern as
# HPD's NO_VIOLATIONS_BBL. Confirmed live: zero rows, i.e. this building has
# never filed a bedbug report at all (a different fact from "filed, zero
# infested").
NEVER_FILED_BBL = "3999999999"


def test_known_building_most_recent_filing():
    r = bedbugs.report(KNOWN_BBL)
    assert r["units_total"] == 135
    assert r["units_infested"] == 9
    assert r["units_eradicated"] == 0
    assert r["units_reinfested"] == 2
    assert r["filing_period_end"] == "2025-10-31"


def test_never_filed_returns_none_not_zero():
    # None means "no record" -- a building that has simply never filed a
    # bedbug report. This must not come back as a dict of zeros, which
    # would silently claim a clean inspection history that doesn't exist.
    assert bedbugs.report(NEVER_FILED_BBL) is None


def test_exposes_its_source():
    assert bedbugs.SOURCE["name"]
    assert "wz6d-d3jb" in bedbugs.SOURCE["url"]
