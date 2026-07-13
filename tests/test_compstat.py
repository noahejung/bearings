import pytest

from bearings.sources import compstat


def test_fetches_the_76th_precinct():
    """The 76th (Cobble Hill / Carroll Gardens) has notably low crime."""
    d = compstat.fetch_precinct(76)
    assert d["precinct"] == 76
    assert d["robbery_ytd"] >= 0
    assert d["total_ytd"] > 0


def test_ytd_figures_are_internally_consistent():
    d = compstat.fetch_precinct(76)
    # Robbery and felony assault are both subsets of total major crime.
    assert d["robbery_ytd"] <= d["total_ytd"]
    assert d["felony_assault_ytd"] <= d["total_ytd"]


def test_percent_change_matches_the_raw_counts():
    d = compstat.fetch_precinct(83)  # Bushwick
    if d["robbery_prior"]:
        implied = (d["robbery_ytd"] - d["robbery_prior"]) / d["robbery_prior"] * 100
        assert abs(implied - d["robbery_pct"]) < 1.0


def test_distinguishes_precincts():
    """Guard against the server handing back one generic file."""
    a = compstat.fetch_precinct(76)
    b = compstat.fetch_precinct(83)
    assert a["total_ytd"] != b["total_ytd"]


def test_reports_the_week_covered():
    d = compstat.fetch_precinct(76)
    assert "/" in d["week_ending"]


def test_undefined_percent_change_does_not_misalign_the_row():
    """Precinct 1's Fel. Assault row has a literal '***.*' token in the
    WTD_pct column (prior-year WTD count was 0, so % change is undefined).
    A naive "keep only numeric-looking tokens" parser drops that token,
    shifting every column after it by one and reading the wrong numbers
    into YTD -- silently, with no error. This is exactly the class of bug
    the newport_path anchor-snap fix exists to catch elsewhere in this
    project: a plausible, wrong number. felony_assault_ytd for the 1st
    Precinct is verified (2026-07-13, live fetch) to be 103, not 80 or 28.
    """
    d = compstat.fetch_precinct(1)
    assert d["felony_assault_ytd"] == 103
    assert d["felony_assault_prior"] == 80
