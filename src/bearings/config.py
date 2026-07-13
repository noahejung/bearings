from pathlib import Path

# --- spatial ---
H3_RES = 9      # profile cell, ~0.105 km2
SHARD_RES = 6   # shard key; one shard holds ~49 res-9 cells

NYC_BBOX = {
    "xmin": -74.30,
    "ymin": 40.47,
    "xmax": -73.70,
    "ymax": 40.93,
}

# --- paths ---
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
RAW_DIR = DATA_DIR / "raw"
DERIVED_DIR = DATA_DIR / "derived"

# --- commute anchors: where people actually go ---
# name -> (lat, lng)
ANCHORS = {
    "midtown":          (40.7549, -73.9840),  # Times Sq-42 St
    "wtc":              (40.7126, -74.0099),  # World Trade Center
    "downtown_brooklyn":(40.6924, -73.9875),  # Jay St-MetroTech
    "newport_path":     (40.7267, -74.0339),  # Newport PATH, Jersey City
}

# --- external sources ---
# VERIFY each of these before first use; see the task that consumes it.
GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search"
MTA_GTFS_URL = "http://web.mta.info/developers/data/nyct/subway/google_transit.zip"

SOCRATA_DOMAIN = "data.cityofnewyork.us"
# 4x4 dataset identifiers. Confirmed-live ones are noted; the rest MUST be
# verified by the task that first fetches them.
SOCRATA_DATASETS = {
    "311":              "erm2-nwe9",  # 311 Service Requests 2010-Present
    "hpd_violations":   "wvxf-dwi5",  # HPD Housing Maintenance Code Violations
    "restaurants":      "43nn-pn8j",  # DOHMH Restaurant Inspections (confirmed)
    "trees":            "uvpi-gqnh",  # 2015 Street Tree Census
    "pluto":            "64uk-42ks",  # Primary Land Use Tax Lot Output (PLUTO)
}

# Overture release string. Changes monthly. VERIFY at docs.overturemaps.org
# before relying on it; the ingest task has an explicit check.
OVERTURE_RELEASE = "2025-06-25.0"
OVERTURE_S3 = (
    "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
)

NYPD_PCT_PDF = (
    "https://www.nyc.gov/assets/nypd/downloads/pdf/crime_statistics/"
    "cs-en-us-{pct:03d}pct.pdf"
)
# nyc.gov 403s on a default client. This is a bot-UA block, not auth.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
