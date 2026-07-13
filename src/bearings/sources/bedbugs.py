"""NYC bedbug filings, most recent per building.

NYC Admin Code 27-2018.1 requires every owner of a multiple dwelling to
file an annual bedbug report. This dataset carries one row per building
per filing year, and joins directly on `bbl` -- confirmed live via a
`$limit=5` probe: `bbl` is a real column here, unlike HPD (which has none
and joins on boroid/block/lot instead -- see hpd.py). A plain zero-padded
BBL string round-trips this dataset's `bbl` column for `=` comparison,
the same coercion PLUTO's `bbl` column does (see pluto.py's docstring).

Columns, confirmed live against the real schema and matching what this
task expected exactly: `bbl`, `of_dwelling_units`,
`infested_dwelling_unit_count`, `eradicated_unit_count`,
`re_infested_dwelling_unit`, `filing_date`, `filing_period_start_date`,
`filling_period_end_date` -- yes, "filling" with two Ls in that last
column name. That is the live column name, not a typo introduced here;
it is used as-is below.

A building can carry several filings on record (roughly one per year).
`socrata.fetch` has no `$order`/`$limit`-top-1` support (nothing else in
this codebase has needed it yet), and a per-BBL filing count is small
(single digits, confirmed live), so "most recent" is decided client-side:
fetch every row for the BBL and sort on `filing_date` in pandas, rather
than adding server-side ordering to the shared client for one caller."""

from bearings.sources import socrata

SOURCE = {
    "name": "NYC Bedbug Filings",
    "url": "https://data.cityofnewyork.us/d/wz6d-d3jb",
}


def report(bbl: str) -> dict | None:
    """The most recent bedbug filing on record for a building, or `None`
    if this BBL has never filed one. `None` means "no record"; a filing
    with zero infested units is a real filing that reported zero -- these
    are different facts and the caller must be able to tell them apart."""
    df = socrata.fetch("bedbugs", where=f"bbl='{bbl}'")
    if df.empty:
        return None

    df = df.sort_values("filing_date", ascending=False)
    row = df.iloc[0]

    return {
        # The live value is an ISO timestamp at midnight ("2025-10-31T00:00:
        # 00.000") for what is really just a date -- the time-of-day part
        # carries no information, so it's trimmed to the date.
        "filing_period_end": str(row["filling_period_end_date"])[:10],
        "units_total": int(row["of_dwelling_units"]),
        "units_infested": int(row["infested_dwelling_unit_count"]),
        "units_reinfested": int(row["re_infested_dwelling_unit"]),
        "units_eradicated": int(row["eradicated_unit_count"]),
    }
