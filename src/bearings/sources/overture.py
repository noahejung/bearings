"""POI ingest from Overture Maps.

Overture ships places as Parquet on S3. DuckDB reads Parquet over HTTP and
pushes our bounding-box predicate down into the scan, so we transfer only
New York's rows rather than the planet's. This is why the ingest is fast and
free."""

import duckdb
import pandas as pd

from bearings import cells, config

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

    src = config.OVERTURE_S3.format(release=config.OVERTURE_RELEASE)
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
