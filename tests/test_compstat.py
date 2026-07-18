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


_LABEL_TO_YTD_KEY = {"Robbery": "robbery_ytd", "Fel. Assault": "felony_assault_ytd"}

# Small, historically low-crime precincts where a weekly count of 0 is
# common enough that NYPD's PDF prints an undefined ("prior count was 0")
# WTD % change -- the literal token "***.*" -- somewhere in at least one of
# these rows most weeks. This is a candidate LIST, not one hardcoded
# precinct, and that's deliberate: this test used to check only precinct
# 1's Fel. Assault row, and while rewriting it (2026-07-18) that row itself
# had already moved on to a defined % change that same week -- the exact
# "don't trust a point-in-time assumption" lesson this project keeps
# relearning, this time about the test's own premise rather than its
# pinned answer. Confirmed live 2026-07-18 by scanning all 78 precincts'
# PDFs: each of these had a "***.*" token landing strictly before the
# YTD_2026 column (i.e. in a position that can actually misalign the read
# -- not merely present harmlessly in the trailing 16yr/33yr trend columns,
# which several other precincts had that week without being useful here).
_UNDEFINED_PCT_PRECINCT_CANDIDATES = [22, 111, 5, 26, 50, 63, 112, 114, 122, 1]


def test_undefined_percent_change_does_not_misalign_the_row():
    """NYPD's PDF prints an undefined WTD % change as the literal token
    "***.*" (when the prior-year WTD count was 0) rather than omitting it
    -- it still occupies its column. A naive "keep only numeric-looking
    tokens" parser drops that token, shifting every column after it by
    one and reading the wrong numbers into YTD -- silently, with no
    error. This is exactly the class of bug the newport_path anchor-snap
    fix exists to catch elsewhere in this project: a plausible, wrong
    number.

    This test originally pinned felony_assault_ytd for Precinct 1 to a
    specific value (103, verified live 2026-07-13). That number is NYPD's
    own weekly-updated count, not a property of the parser, and it moved
    to 105 the same week this test was revisited (confirmed live
    2026-07-18) -- a legitimate data change, not a code defect. Pinning a
    point-in-time value as a proxy for a structural property (columns
    landing in the right place) breaks CI every time NYPD publishes new
    numbers, which trains everyone to ignore red CI -- worse than no
    guard at all. Rewritten below to assert the structural property
    directly instead: re-derive what the naive, buggy "drop non-numeric
    tokens" parser would have produced from the same live row, and
    confirm the real parser disagrees with it. That holds no matter what
    NYPD's current numbers are, so it never needs updating for THAT
    reason again. (No separate pinned-value "drift alert" was added
    elsewhere either -- NYPD's numbers changing week to week is expected,
    not a signal anything needs attention, so there's nothing worth
    alerting on.)
    """
    found = None
    for pct in _UNDEFINED_PCT_PRECINCT_CANDIDATES:
        text = compstat._text(pct)
        for label in _LABEL_TO_YTD_KEY:
            tokens = compstat._row_tokens(text, label)
            # Must land before the YTD_2026 column (index _YTD_THIS_IDX) to
            # actually be capable of shifting it -- a "***.*" in a trailing
            # trend column (16yr/33yr) wouldn't misalign anything here.
            if any(t == "***.*" for t in tokens[: compstat._YTD_THIS_IDX]):
                found = (pct, label, tokens)
                break
        if found:
            break

    if found is None:
        pytest.fail(
            "None of the known low-crime-precinct candidates currently "
            "have an undefined ('***.*') WTD % change ahead of the YTD "
            "column, so this test can't exercise its guard against live "
            "data this week. Find a fresh one (scan more precincts' PDFs "
            "for the token, same way this test's own docstring was "
            "verified) and add it to _UNDEFINED_PCT_PRECINCT_CANDIDATES --"
            " don't skip this check, the scenario recurs most weeks."
        )

    pct, label, tokens = found

    # Reproduce the bug: filtering to "tokens that parse as a number" drops
    # "***.*" and shifts every later column left by one, so a parser
    # indexing by position (as this module does, deliberately, in
    # `_YTD_THIS_IDX`) would read the WRONG column into "this year".
    naive_tokens = [t for t in tokens if compstat._num(t) is not None]
    naive_ytd_this_year = compstat._num(naive_tokens[compstat._YTD_THIS_IDX])

    d = compstat.fetch_precinct(pct)
    real_ytd_this_year = d[_LABEL_TO_YTD_KEY[label]]
    assert real_ytd_this_year != naive_ytd_this_year
