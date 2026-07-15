"""HPD housing code violations, open only.

This dataset has no `bbl` column -- confirmed live: absent from a
`$limit=5` probe of every field. It carries `boroid`, `block`, `lot`
instead, which together are exactly a BBL's three components, so the BBL
the geocoder hands us is split back into them to join. HPD's `block`/`lot`
columns are un-padded plain integers-as-text ("3031", not "03031"), unlike
the zero-padded BBL string, so the padding has to come back off.

`class` is one of A/B/C/I (confirmed live via `$select=distinct class`);
class C is *immediately hazardous* -- the number that matters.
`violationstatus` is "Open" or "Close" (confirmed live -- not "Closed")."""

import pandas as pd

from bearings.sources import socrata

SOURCE = {"name": "NYC HPD", "url": "https://data.cityofnewyork.us/d/wvxf-dwi5"}

_EMPTY = {"class_a": 0, "class_b": 0, "class_c": 0}
_KEY_FOR_CLASS = {"A": "class_a", "B": "class_b", "C": "class_c"}


def _bbl_parts(bbl: str) -> tuple[str, str, str]:
    """Split a 10-char BBL (borough[1] + block[5] + lot[4], zero-padded)
    into HPD's un-padded (boroid, block, lot) column values."""
    boro = bbl[0]
    block = str(int(bbl[1:6]))
    lot = str(int(bbl[6:10]))
    return boro, block, lot


def open_violations(bbl: str) -> dict:
    """Open violation counts by class for a building, keyed `class_a`/
    `class_b`/`class_c`. Class I ("Info") is not tracked -- it is not a
    hazard class."""
    boro, block, lot = _bbl_parts(bbl)
    where = (
        f"boroid='{boro}' AND block='{block}' AND lot='{lot}' "
        f"AND violationstatus='Open'"
    )
    df = socrata.fetch("hpd_violations", select="class", where=where)

    if df.empty:
        return dict(_EMPTY)

    counts = df["class"].value_counts()
    return {
        key: int(counts.get(cls, 0)) for cls, key in _KEY_FOR_CLASS.items()
    }


def citywide_open_class_c_counts() -> pd.DataFrame:
    """Every (boroid, block, lot) citywide with at least one open Class C
    ("immediately hazardous") violation, and how many -- for the per-cell
    precompute bake (bearings.cellprofile), which aggregates HPD's serious
    housing-hazard signal to the cell level. Class C only (not A/B): see
    this module's own docstring -- "the number that matters".

    Fetches the raw open-Class-C violation rows (confirmed live 2026-07-15:
    581,733 rows, ~40s across ~12 Socrata pages) and aggregates client-side
    with pandas, rather than a server-side SoQL $group query -- a live
    probe found Socrata's own $group+$order aggregate on this dataset times
    out past 60s (no index on boroid/block/lot), while a bare $group with
    no $order returns in under a second but with an unstable row order that
    cannot be paginated reliably. Paging the raw rows (each page is fast
    and independently correct regardless of ordering) and counting in
    pandas sidesteps both problems.
    """
    df = socrata.fetch(
        "hpd_violations",
        select="boroid,block,lot",
        where="class='C' AND violationstatus='Open'",
    )
    if df.empty:
        return pd.DataFrame({"boroid": [], "block": [], "lot": [], "count": []})
    return df.groupby(["boroid", "block", "lot"]).size().reset_index(name="count")
