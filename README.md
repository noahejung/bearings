# bearings

A per-address "what is daily life actually like here" report for New York
City, built entirely on free public data. Type an address, get back real
GTFS-derived transit times to a handful of commute anchors, nearby subway
and PATH stations, amenity density (grocery, cafe, bar, restaurant,
pharmacy, gym, park) within a ~10-minute walk, and precinct-level crime
stats. Nothing touches an external API at read time -- the underlying
sources are ingested, spatially indexed to H3 hexagons, and cached locally
before the CLI ever runs a query. Full design context and the reasoning
behind the product angle lives in the vault at `Projects/bearings/SPEC.md`.

This is Phase 1: the ingest pipeline and a working CLI. There is no UI yet.

## Running it

```bash
uv sync
uv run bearings profile "350 5th Ave, Manhattan"
```

First run is slow -- it downloads and caches the MTA subway GTFS feed
(~5.5MB), the PATH GTFS feed (~1.2MB), and queries Overture's Places
Parquet for the whole NYC bounding box (50k+ rows) via DuckDB over S3.
Everything lands in `data/` (gitignored) and is reused on subsequent runs.

Output is JSON:

```json
{
  "address": "350 5 AVENUE, New York, NY, USA",
  "cell": "892a100d2d7ffff",
  "shard": "862a100d7ffffff",
  "location": {"lat": 40.748441, "lng": -73.985656, "bbl": "1008350041"},
  "transit": {
    "nearest_stations": [
      {"stop_id": "D17", "name": "34 St-Herald Sq",
       "routes": ["B","D","F","M","N","Q","R","W"], "walk_minutes": 3}
    ],
    "to_anchors": {"midtown": 6, "wtc": 18, "downtown_brooklyn": 26, "newport_path": 23}
  },
  "amenities": {"restaurant": 74, "cafe": 21, "bar": 9, "grocery": 6,
                "pharmacy": 4, "gym": 3, "park": 1},
  "safety": {"precinct": 14, "week_ending": "7/5/2026",
             "robbery_ytd": 24, "robbery_pct": -20.0,
             "felony_assault_ytd": 52, "felony_assault_pct": 6.1,
             "total_ytd": 230, "total_pct": -6.12}
}
```

## Data sources

| Source | What we take | Access | License / terms |
| --- | --- | --- | --- |
| [NYC Planning Labs GeoSearch](https://geosearch.planninglabs.nyc/) | Address -> (lat, lng, BBL) | Free, keyless REST API | Public NYC service; no key or attribution requirement published |
| [MTA GTFS (subway)](http://web.mta.info/developers/data-nyct-subway.html) | Station locations + full timetable | Free zip download | MTA Developer Data Terms of Use (free use, attribution requested) |
| [PATH GTFS](https://www.panynj.gov/path/en/schedules-maps/gtfs-realtime.html) (served via Trillium Transit) | Station locations + full timetable for the 13 PATH stations | Free zip download | Published by the Port Authority as open transit data |
| [Overture Maps Places](https://overturemaps.org/) | POIs (name, category, location) for all of NYC | Free, keyless Parquet-over-S3, queried with DuckDB | See [overturemaps.org/data](https://overturemaps.org/data) for the current per-theme license and attribution requirements before any public-facing use |
| [NYC Open Data / Socrata](https://data.cityofnewyork.us/) | Police precinct boundaries (dataset `y76i-bdw7`); Socrata client is also wired for 311, HPD violations, PLUTO, tree census (unused in Phase 1) | Free REST API, paginated | NYC Open Data Terms of Use -- public data, generally free to reuse |
| [NYPD CompStat](https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page) | Per-precinct YTD robbery / felony assault / total major crime | Public PDF, requires a browser User-Agent (bot-UA block, not auth) | Public NYPD statistical release |

## Known simplifications

Stated honestly, on purpose -- an engineer reading this code should respect
a stated simplification and distrust a hidden one.

- **Transit times are median inter-station ride time plus a flat 240s
  (4-minute) transfer penalty, not headway-aware routing.** This is not
  RAPTOR or any real journey planner: it doesn't know train frequency,
  time of day, or that PATH runs far less often than the subway off-peak.
  A computed number can therefore read a little optimistic versus a real
  door-to-door commute, especially across a subway<->PATH transfer.
- **Amenity counts are a res-9 H3 k-ring (the cell plus its six
  neighbours), not a true walk-network isochrone.** A k-ring is roughly a
  10-minute walk in open street grids, but it's a hex disk, not the actual
  reachable street network -- it can over- or under-count near rivers,
  parks, highways, or anywhere the walkable network doesn't match a
  regular hex tiling.
- **`safety` is YTD counts for exactly two crime categories** (robbery,
  felony assault) plus a total, from the most recent weekly CompStat PDF.
  It is not a comprehensive crime picture, and "total" includes categories
  (burglary, grand larceny, etc.) not broken out individually.

## Not simplifications (fixed, not worked around)

Two things that could easily have shipped as known limitations were fixed
instead, because the failure mode was silent wrong data rather than an
honest gap:

- **The `newport_path` anchor is a real PATH station, not a stand-in.**
  Newport is in Jersey City, served by PATH -- not the MTA subway. Before
  the PATH feed was added, the anchor silently snapped to the nearest
  *subway* station (Canal St, 2,367m away) and reported Times Sq -> Newport
  as 8.5 minutes. `transit.MAX_ANCHOR_SNAP_M` now makes that class of bug
  impossible to ship silently: any anchor whose nearest graph station is
  more than 400m away raises `AnchorSnapTooFar` instead of computing a
  number. The PATH GTFS feed is merged into the same graph as the subway
  (namespaced `PATH:` stop IDs to rule out an ID collision), so all four
  anchors now resolve to a station that is actually there.
- **The Overture release is resolved at runtime, not pinned.** Overture
  retains only the last two releases, so a hardcoded release string breaks
  the pipeline roughly monthly -- this plan's original pin was a year
  stale on day one. `overture.resolve_release()` lists the public S3
  bucket, takes the newest well-formed release, and caches it in-process,
  falling back to a pinned value (logged loudly) only if the listing call
  itself fails.

## Project layout

See `Projects/bearings/PLAN.md` in the vault for the full task-by-task
implementation history. Short version:

```
src/bearings/
  config.py            # constants: H3 res, NYC bbox, dataset IDs, paths, anchors
  geocode.py            # address -> (lat, lng) via NYC GeoSearch
  cells.py              # pure H3 helpers, no I/O
  sources/
    socrata.py           # generic paginated NYC Open Data fetcher
    overture.py           # POIs via DuckDB over S3 Parquet + runtime release resolution
    gtfs.py                # MTA + PATH GTFS ingest, one code path for both feeds
    compstat.py             # NYPD precinct PDFs -> crime table
    precincts.py              # precinct boundary point-in-polygon join
  transit.py            # GTFS -> graph -> real travel times from anchors
  profile.py            # assemble the per-address profile
  cli.py                 # `bearings profile "<address>"`
```
