"""POI ingest from Overture Maps.

Overture ships places as Parquet on S3. DuckDB reads Parquet over HTTP and
pushes our bounding-box predicate down into the scan, so we transfer only
New York's rows rather than the planet's. This is why the ingest is fast and
free."""

import logging
import re
from functools import lru_cache

import duckdb
import httpx
import pandas as pd

from bearings import cells, config

logger = logging.getLogger(__name__)

# Overture retains only the last two releases, so a hardcoded release string
# breaks the pipeline roughly monthly (the plan originally shipped one that
# was a year stale on day one). Resolve the newest one at runtime instead;
# config.OVERTURE_RELEASE becomes a last-resort fallback for when the bucket
# listing itself is unreachable.
_RELEASE_LIST_URL = (
    "https://overturemaps-us-west-2.s3.amazonaws.com/"
    "?list-type=2&delimiter=/&prefix=release/"
)
_RELEASE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
# S3's ListBucketResult XML is a fixed, known shape (one <Prefix> per
# <CommonPrefixes>). A full XML parser (stdlib xml.etree is XXE-vulnerable;
# avoiding a defusedxml dependency for one field) is unwarranted for
# pulling a single well-known tag out of a trusted AWS endpoint's response.
_PREFIX_TAG_RE = re.compile(r"<Prefix>release/([^<]+)/</Prefix>")


@lru_cache(maxsize=1)
def resolve_release() -> str:
    """The newest Overture release, resolved by listing the public S3
    bucket. Cached in-process: one bucket listing per run, not per query.

    Falls back to the pinned config.OVERTURE_RELEASE -- logged loudly,
    since a silent fallback is exactly the kind of rot this function
    exists to prevent -- if the listing call fails or returns nothing
    that looks like a release.
    """
    try:
        resp = httpx.get(_RELEASE_LIST_URL, timeout=15.0)
        resp.raise_for_status()
        versions = [
            v for v in _PREFIX_TAG_RE.findall(resp.text) if _RELEASE_RE.match(v)
        ]
        if not versions:
            raise ValueError(
                f"bucket listing returned no well-formed release prefixes "
                f"(response: {resp.text[:500]!r})"
            )
        return sorted(versions)[-1]
    except Exception:
        logger.warning(
            "Overture release auto-resolution failed; falling back to the "
            "pinned config.OVERTURE_RELEASE=%r. This value will go stale -- "
            "fix the resolver rather than re-pinning this fallback.",
            config.OVERTURE_RELEASE,
            exc_info=True,
        )
        return config.OVERTURE_RELEASE


# Overture's category taxonomy is deep. We only care about the categories that
# answer "what is daily life like here", so collapse them into seven buckets.
CATEGORY_MAP = {
    "grocery_store": "grocery",
    "supermarket": "grocery",
    "cafe": "cafe",
    "coffee_shop": "cafe",
    "bar": "bar",
    "pub": "bar",
    "restaurant": "restaurant",
    "pharmacy": "pharmacy",
    "gym": "gym",
    "fitness_center": "gym",
    "laundry": "laundry",
    "laundromat": "laundry",
    "park": "park",
}


def _bucket(raw: str | None) -> str:
    if not raw:
        return "other"
    return CATEGORY_MAP.get(raw, "other")


def fetch_pois() -> pd.DataFrame:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region='us-west-2';")

    src = config.OVERTURE_S3.format(release=resolve_release())
    b = config.NYC_BBOX

    query = f"""
        SELECT
            names.primary               AS name,
            categories.primary          AS raw_category,
            ST_Y(geometry)               AS lat,
            ST_X(geometry)               AS lng
        FROM read_parquet('{src}', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN {b["xmin"]} AND {b["xmax"]}
          AND bbox.ymin BETWEEN {b["ymin"]} AND {b["ymax"]}
          AND names.primary IS NOT NULL
    """

    df = con.execute(query).fetch_df()

    # Overture's per-feature bbox field is float32-quantized, so a handful of
    # points whose true coordinate sits right at the pushed-down bbox edge
    # slip past the scan-level filter by a hair. Re-filter on the exact
    # computed lat/lng to guarantee every returned row is actually inside NYC.
    df = df[
        df["lat"].between(b["ymin"], b["ymax"])
        & df["lng"].between(b["xmin"], b["xmax"])
    ].reset_index(drop=True)

    df["category"] = df["raw_category"].map(_bucket)
    df["cell"] = [
        cells.cell_for(lat, lng)
        for lat, lng in zip(df["lat"], df["lng"], strict=True)
    ]

    return df[["name", "category", "lat", "lng", "cell"]]
