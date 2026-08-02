from bearings.sources import complaints


def test_major_felony_offenses_match_compstats_own_seven():
    # See compstat.py's own TOTAL row -- CompStat's citywide "TOTAL" is the
    # sum of exactly these seven offense categories. Kept identical so the
    # block-level count and the existing precinct figure stay comparable
    # (2026-08-02 dispatch's own instruction).
    assert complaints.MAJOR_FELONY_OFFENSES == (
        "MURDER & NON-NEGL. MANSLAUGHTER",
        "RAPE",
        "ROBBERY",
        "FELONY ASSAULT",
        "BURGLARY",
        "GRAND LARCENY",
        "GRAND LARCENY OF MOTOR VEHICLE",
    )


def test_year_boundary_is_january_1_of_the_current_year():
    import datetime as dt

    year = dt.datetime.now(dt.timezone.utc).year
    assert complaints._year_boundary() == f"{year}-01-01T00:00:00"


def test_citywide_points_returns_a_real_nontrivial_citywide_set():
    # Live-measured 2026-08-02: the seven major-felony categories alone run
    # ~240k rows over roughly the trailing 30 months, so 24 months of BOTH
    # datasets combined must clear a real five-figure floor -- guards
    # against a silently-empty or badly-scoped fetch (an empty result would
    # otherwise look like "no crime happened anywhere in NYC", the exact
    # "only ever observes zeros" trap this project's own invariants call
    # out).
    df = complaints.citywide_points()
    assert len(df) > 50_000
    assert set(df.columns) == {"lat", "lng"}
    # NaN/unparseable rows are dropped by citywide_points() itself, not
    # silently kept as garbage -- but a live probe (2026-08-02) found this
    # dataset carries its own rare (0.0, 0.0) unset-sentinel rows (2 of
    # 217,377, ~0.001%), the same known garbage-coordinate shape
    # cellprofile.py's own `_safe_cell_for()` guard already exists to
    # tolerate for the 311 noise feed -- so the bar here is "the
    # overwhelming majority are real NYC coordinates," not literally every
    # row, matching that established precedent rather than a stricter one
    # this dataset doesn't actually meet.
    in_nyc = df["lat"].between(40.0, 41.5) & df["lng"].between(-74.5, -73.4)
    assert in_nyc.mean() > 0.999


def test_citywide_points_excludes_rows_from_before_the_lookback_window():
    # A short lookback (1 month) must return dramatically fewer rows than
    # the default 24-month window -- a real, live-measurable difference,
    # not just "returns something."
    wide = complaints.citywide_points(lookback_months=24)
    narrow = complaints.citywide_points(lookback_months=1)
    assert len(narrow) < len(wide)
    assert len(narrow) > 0


def test_exposes_its_source():
    assert complaints.SOURCE["name"]
    assert "qgea-i56i" in complaints.SOURCE["url"]
