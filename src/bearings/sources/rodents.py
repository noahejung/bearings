"""DOHMH rodent inspections, joined per building.

`latitude`/`longitude` are reportedly often `0.0` on this dataset --
confirmed live (one of the first five rows probed carries exactly
`"0.00000000000000000000"` for both), so this never joins on them.
Instead it joins the same way HPD does: split the BBL the geocoder hands
us into `boro_code`/`block`/`lot` and match those columns directly (see
hpd.py's docstring for the exact padding rule this mirrors -- this
dataset's `block`/`lot` are un-padded plain integers-as-text, same as
HPD's). A real `bbl` column does exist here too, but only on newer rows
-- it is genuinely absent (not blank) on some older records, confirmed
live -- so the boro/block/lot join is the reliable one, not a
belt-and-suspenders extra.

**Schema discrepancy from what this task described:** `result` does
*not* carry a plain `"Failed"` value -- confirmed live via
`$select=distinct result`, the full set is `Passed`, `Bait applied`,
`Cleanup done`, `Monitoring visit`, `Stoppage done`, and three separate
fail reasons: `Failed for Other Reason`, `Failed for Rat Activity`,
`Failed for Rat Activity and Other Reason`. A "failed" count has to match
on the `Failed` *prefix*, not equality.

**A second thing the task didn't mention, found only by cross-tabulating
`inspection_type` against `result` live:** this dataset mixes two
different kinds of row under one schema. Only `inspection_type` in
(`Initial`, `Compliance`) ever carries a `Passed`/`Failed*` verdict --
`Treatments` (bait drops), `Stoppage`, and `Clean Ups` rows are follow-up
service visits with their own non-verdict `result` values (`Bait
applied`, `Stoppage done`, etc.) and would silently inflate an
"inspections" count with visits that never inspected anything. This
module filters to `Initial`/`Compliance` for exactly that reason: an
"11 inspections, 3 failed" that was actually "4 real inspections (3
failed) plus 7 bait-application stops" is precisely the kind of
confidently-wrong number this project has shipped before and is trying
not to ship again."""

from datetime import datetime, timedelta, timezone

from bearings.sources import socrata

SOURCE = {
    "name": "NYC DOHMH Rodent Inspections",
    "url": "https://data.cityofnewyork.us/d/p937-wjvj",
}

_VERDICT_TYPES = "'Initial','Compliance'"


def _bbl_parts(bbl: str) -> tuple[str, str, str]:
    """Split a 10-char BBL (borough[1] + block[5] + lot[4], zero-padded)
    into this dataset's un-padded (boro_code, block, lot) column values.
    Mirrors hpd.py's `_bbl_parts` exactly -- same padding rule, different
    dataset's column names."""
    boro = bbl[0]
    block = str(int(bbl[1:6]))
    lot = str(int(bbl[6:10]))
    return boro, block, lot


def inspections(bbl: str, months: int = 24) -> dict | None:
    """Inspection summary for a building over the trailing `months`
    months, counting only `Initial`/`Compliance` visits -- the ones that
    carry a real pass/fail verdict (see module docstring). Returns `None`
    if the property has never been inspected in that window; this is a
    different fact from "inspected and passed every time", which is a
    real dict with `inspections > 0` and `failed == 0`."""
    boro, block, lot = _bbl_parts(bbl)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=months * 30)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    where = (
        f"boro_code='{boro}' AND block='{block}' AND lot='{lot}' "
        f"AND inspection_date > '{cutoff}' "
        f"AND inspection_type IN ({_VERDICT_TYPES})"
    )
    df = socrata.fetch("rodents", where=where)
    if df.empty:
        return None

    df = df.sort_values("inspection_date", ascending=False)
    last = df.iloc[0]
    failed = int(df["result"].str.startswith("Failed").sum())

    return {
        "inspections": int(len(df)),
        "failed": failed,
        "last_result": last["result"],
        "last_date": str(last["inspection_date"])[:10],
    }
