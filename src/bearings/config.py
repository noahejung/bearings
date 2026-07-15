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

# PATH (Port Authority Trans-Hudson) serves Jersey City/Newark/Hoboken --
# not MTA subway territory, but the newport_path anchor lives there.
PATH_GTFS_URL = "https://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip"

# FEMA National Flood Hazard Layer, public ArcGIS MapServer (confirmed live
# 2026-07-13 -- found by web search, not guessed). Layer 28 is "Flood
# Hazard Zones", the one polygon layer that carries a FLD_ZONE per polygon.
FEMA_NFHL_QUERY_URL = (
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
)

SOCRATA_DOMAIN = "data.cityofnewyork.us"
# 4x4 dataset identifiers. Confirmed-live ones are noted; the rest MUST be
# verified by the task that first fetches them.
SOCRATA_DATASETS = {
    "311":              "erm2-nwe9",  # 311 Service Requests 2010-Present
    "hpd_violations":   "wvxf-dwi5",  # HPD Housing Maintenance Code Violations
    "restaurants":      "43nn-pn8j",  # DOHMH Restaurant Inspections (confirmed)
    "trees":            "uvpi-gqnh",  # 2015 Street Tree Census
    "pluto":            "64uk-42ks",  # Primary Land Use Tax Lot Output (PLUTO)
    "bedbugs":          "wz6d-d3jb",  # Bedbug Reporting (confirmed live 2026-07-13)
    "rodents":          "p937-wjvj",  # DOHMH Rodent Inspections (confirmed live 2026-07-13)
    "buildings":        "5zhs-2jue",  # BUILDING -- NYC building footprints (confirmed live 2026-07-14)
    "centerlines":      "inkn-q76z",  # NYC Street Centerline (CSCL) (confirmed live 2026-07-14)
}

# Overture release string. NOT used directly by fetch_pois() anymore --
# overture.resolve_release() lists the public S3 bucket at runtime and picks
# the newest release, because Overture retains only the last two releases
# and a hardcoded string breaks the pipeline roughly monthly (the plan's
# original "2025-06-25.0" was exactly one year stale on day one). This
# constant survives only as resolve_release()'s last-resort fallback for
# when the bucket listing itself is unreachable; keep it roughly current
# but do not depend on it being current.
OVERTURE_RELEASE = "2026-06-17.0"
OVERTURE_S3 = (
    "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
)

# NYPD precinct boundaries. Verified live 2026-07-13: 78 features, not the
# 77 precincts NYPD publicly counts -- precinct "22" is the Central Park
# Precinct, a real numbered precinct this dataset includes but that NYPD's
# "77 precincts" figure conventionally excludes. Column is "precinct".
PRECINCT_GEOJSON = "https://data.cityofnewyork.us/resource/y76i-bdw7.geojson"
# Douglas-Peucker tolerance (degrees) used when simplifying precinct polygons
# for the citywide choropleth -- 0.0003deg is ~30m at NYC's latitude, live-
# measured to cut the citywide payload from 3.83MB to 243KB (78 precincts,
# 6,132 total points) with no visible loss at any zoom where the whole city
# fits on screen. See bearings/sources/precincts.py's precinct_features().
PRECINCT_SIMPLIFY_TOLERANCE_DEG = 0.0003

# 2020 Neighborhood Tabulation Areas (NTAs) -- confirmed live 2026-07-15 via
# the Socrata catalog (api.us.socrata.com/api/catalog/v1?q=neighborhood+
# tabulation): dataset "9nt8-h7nd", 262 features, columns nta2020/ntaname/
# boroname/the_geom. Not the "2020 NTAs - Mapped" lens (4hft-v355), which
# per this codebase's established pattern for map-lens datasets carries no
# queryable columns. Used only for label placement (name + centroid), never
# for a shaded layer -- see bearings/sources/neighborhoods.py.
NTA_GEOJSON = "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson"

# The Protomaps daily-build planet PMTiles basemap. `bearings.sources.
# basemap` extracts just the NYC bbox from this remote archive over HTTP
# range requests via the `pmtiles` CLI (protomaps/go-pmtiles) -- it never
# downloads the full ~120GB planet file. Builds are retained for the past
# week only (Protomaps' own retention policy, see docs.protomaps.com/
# basemaps/downloads), so the date is resolved at bake time, not pinned --
# same self-resolving shape as OVERTURE_RELEASE above, for the same reason.
PMTILES_BUILD_HOST = "https://build.protomaps.com"
PMTILES_BUILD_LOOKBACK_DAYS = 10

# --- disk-cache freshness (see bearings.staleness) ---
# Every one of these caches is write-once, read-forever -- crossing this
# window doesn't block anything or trigger a refetch, it only turns a
# silent staleness failure into a loud warning. Picked from each source's
# own documented publish cadence, with slack: Overture ships a new release
# roughly monthly, GTFS schedules change a handful of times a year, NYPD
# republishes CompStat weekly (README.md), and precinct boundaries are
# essentially static (the last NYPD precinct was added in 2013).
POI_CACHE_MAX_AGE_S = 30 * 86400
ANCHOR_TIMES_CACHE_MAX_AGE_S = 30 * 86400
GTFS_CACHE_MAX_AGE_S = 30 * 86400
COMPSTAT_CACHE_MAX_AGE_S = 10 * 86400
PRECINCT_CACHE_MAX_AGE_S = 365 * 86400
NTA_CACHE_MAX_AGE_S = 365 * 86400  # NTA boundaries are redrawn once a decade
# The daily PMTiles basemap build churns constantly (upstream OSM edits),
# but that's a source-freshness question, not a "did our bake go stale"
# question -- the local extract is a point-in-time snapshot by design (baked
# once at build time, same tradeoff as the POI table). A generous window so
# a long-lived local dev/ directory still gets a loud nudge eventually.
BASEMAP_CACHE_MAX_AGE_S = 30 * 86400
CITYWIDE_CACHE_MAX_AGE_S = 10 * 86400  # matches COMPSTAT_CACHE_MAX_AGE_S below
# Per-cell profile precompute (bearings.cellprofile) -- bundles crime, so
# the same cadence as CITYWIDE_CACHE_MAX_AGE_S/COMPSTAT_CACHE_MAX_AGE_S is
# the binding freshness constraint (noise/trees/PLUTO/HPD all change slower
# than weekly CompStat republishing).
CELL_PROFILE_CACHE_MAX_AGE_S = 10 * 86400
# Building footprints and street centrelines change rarely (new construction,
# demolitions, occasional street re-mapping) -- same 30-day slack as the POI
# table, which is baked from a similarly-official, similarly-infrequent source.
BUILDINGS_CACHE_MAX_AGE_S = 30 * 86400
CENTERLINES_CACHE_MAX_AGE_S = 30 * 86400

NYPD_PCT_PDF = (
    "https://www.nyc.gov/assets/nypd/downloads/pdf/crime_statistics/"
    "cs-en-us-{pct:03d}pct.pdf"
)
# nyc.gov 403s on a default client. This is a bot-UA block, not auth.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
