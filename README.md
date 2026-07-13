# bearings

A per-address "what is daily life actually like here" report for New York
City, built entirely on free public data -- and a fact-checker that runs a
real estate listing's own marketing copy ("quiet, tree-lined, steps from
the subway") against that same data and shows what the record actually
says. Type an address, get back real GTFS-derived transit times to a
handful of commute anchors, nearby subway and PATH stations, amenity
density within a ~10-minute walk, 311 noise complaints, street-tree counts,
precinct crime, and a building's year built plus its open HPD violations.
Nothing touches an external API at read time -- the underlying sources are
ingested, spatially indexed to H3 hexagons, and cached locally before the
CLI or API ever answers a query. The fact-checker never renders a verdict
("misleading," "a scam") -- it reports a sourced number and lets the reader
draw the conclusion; that's a deliberate legal and product choice, not an
oversight, see the rule at the bottom of this file. Full design context and
the reasoning behind the product angle lives in the vault at
`Projects/bearings/SPEC.md`.

Phase 1 (the ingest pipeline, the CLI, and the `bearings.api` FastAPI wrapper) is
done. Phase 2 (`web/`) is a React + TypeScript front end for the report and the
fact-checker -- see "Running the front end" below.

## Running it

```bash
uv sync
uv run bearings profile "350 5th Ave, Manhattan"
```

First run is slow -- it downloads and caches the MTA subway GTFS feed
(~5.5MB), the PATH GTFS feed (~1.2MB), and queries Overture's Places
Parquet for the whole NYC bounding box (50k+ rows) via DuckDB over S3.
Everything lands in `data/` (gitignored) and is reused on subsequent runs.

Output is JSON -- captured live from a real run against `350 5th Ave,
Manhattan` (trimmed for length; the real output also carries `shard` and
every nearby station, not just one):

```json
{
  "address": "350 5 AVENUE, New York, NY, USA",
  "cell": "892a100d2d7ffff",
  "location": {"lat": 40.748441, "lng": -73.985656, "bbl": "1008350041"},
  "transit": {
    "nearest_stations": [
      {"stop_id": "R17", "name": "34 St-Herald Sq", "routes": ["N","Q","R","W"], "walk_minutes": 3}
    ],
    "to_anchors": {"midtown": 5, "wtc": 21, "downtown_brooklyn": 24, "newport_path": 17}
  },
  "amenities": {"cafe": 105, "restaurant": 65, "bar": 64, "gym": 49,
                "pharmacy": 26, "park": 18, "grocery": 14, "laundry": 1},
  "safety": {"precinct": 14, "week_ending": "7/5/2026",
             "robbery_ytd": 122, "robbery_pct": -31.8,
             "felony_assault_ytd": 285, "felony_assault_pct": -2.1,
             "total_ytd": 1445, "total_pct": -11.46},
  "quiet": {"noise_complaints_12mo": 1296,
            "source": {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"}},
  "green": {"street_trees_nearby": 277,
            "source": {"name": "NYC Street Tree Census", "url": "https://data.cityofnewyork.us/d/uvpi-gqnh"}},
  "building": {"year_built": 1931, "era": "prewar",
               "era_note": "Pre-war walk-up stock often carries rent-stabilised units, so a cheap apartment may exist here. This is a signal, not a promise.",
               "hpd_open_violations": {"class_a": 0, "class_b": 0, "class_c": 0},
               "source": {"name": "NYC PLUTO + HPD", "url": "https://data.cityofnewyork.us/d/wvxf-dwi5"}}
}
```

## Running the API

```bash
uv sync
uv run uvicorn bearings.api:app --host 127.0.0.1 --port 8000
```

Three endpoints:

- `GET /api/health` -> `{"status": "ok", "warm": bool}`
- `GET /api/profile?address=<str>` -> the full profile (transit, amenities, safety, quiet, green, building); every one of those six blocks carries its own `source`
- `POST /api/factcheck` body `{"address": str, "listing_text": str}` -> claim-by-claim fact check of listing marketing copy against the real data

`/api/factcheck` is the rule this whole project is built around, made
concrete. One real claim from a live run against `1520 Sedgwick Ave, Bronx`
with the listing text `"...well-maintained 2BR..."`:

```json
{
  "quote": "well-maintained",
  "predicate": "violations",
  "status": "contradicted",
  "evidence": "72 open Class C (immediately hazardous) HPD violations on record for this building.",
  "value": 72,
  "source": {"name": "NYC PLUTO + HPD", "url": "https://data.cityofnewyork.us/d/wvxf-dwi5"}
}
```

Notice what `status` and `evidence` do *not* say: not "this landlord is
lying," not "misleading." `contradicted` is a data-driven classification
(the claim disagrees with a real, cited number), never an editorial one.
That distinction is the whole legal and product thesis of this project --
see "The rule that governs the output" at the bottom of this file.

**Boots warm.** Every module-level cache `profile_for()` depends on (the
Overture POI table, both GTFS feeds, the transit graph, the anchor-time
Dijkstra run) is pre-warmed in the FastAPI lifespan startup handler, which
uvicorn blocks on before it opens its listening socket -- no request can
ever arrive before warm-up finishes, and `/api/health` reports `warm: false`
until it does. The two slowest pieces (the POI table and the anchor-time
dict) are additionally persisted to `data/derived/` as Parquet/JSON, so only
the very first boot in a given `data/` directory's life pays the full cost.

Measured on this machine (raw GTFS/precinct downloads already cached in
`data/raw/`, which is the realistic case -- those persist independently of
`data/derived/`):

| | wall-clock, process launch -> `/api/health` reports `warm: true` |
| --- | --- |
| Cold boot (no `data/derived/` yet) | ~39.8s (~38.5s is the Overture POI pull over S3; the rest is Python/library import overhead) |
| Warm boot (`data/derived/` already populated) | ~5.0s (~1.1s is cache warm-up; the rest is Python/library import overhead -- `duckdb`, `pandas`, `networkx`, `fastapi`) |

Bad or out-of-NYC addresses return **422** with a real message, never a
500 -- `geocode.GeocodeError` is caught at both endpoints.

## Running the front end

The API must already be running (see above) -- the dev server proxies `/api/*`
straight to it.

```bash
cd web
npm install   # first time only; installs from package.json, never a bare `npm install <pkg>`
npm run dev
```

Open the printed local URL (usually `http://localhost:5173` -- Vite tries
the next port up if that one's already in use). Click any example address
chip for an instant report (no typing required), then "Load the example
listing" **and then "Check this listing"** on the fact-check section for a
one-click, pre-verified example: a real Bronx address whose listing copy is
genuinely contradicted by the record (72 open Class C -- "immediately
hazardous" -- HPD violations against a "well-maintained" claim; 1,409 noise
complaints against a "quiet" claim -- both numbers confirmed live). Loading
the example only pulls the address record; the fact-check itself is a
separate submit, same as pasting your own listing text.

`npm run build` type-checks (`tsc -b`) and produces a static `web/dist/` --
no server-side rendering, no API keys baked in. `VITE_API_BASE_URL` overrides
the API origin for a build where the two aren't served from the same host;
it defaults to relative `/api/...` paths.

Stack: Vite + React + TypeScript, hand-written CSS (no component library, no
Tailwind), no animation library -- all motion is CSS, gated behind
`prefers-reduced-motion`. Light and dark themes both fully styled; the theme
toggle persists to `localStorage` and otherwise follows the OS preference.

## Data sources -- total licensing cost: $0

All of the following are wired in and actively used (nothing here is a
"not yet ingested" placeholder, except where noted under Known
simplifications).

| Source | What we take | Access | License / terms |
| --- | --- | --- | --- |
| [NYC Planning Labs GeoSearch](https://geosearch.planninglabs.nyc/) | Address -> (lat, lng, BBL) | Free, keyless REST API | Public NYC service; no key or attribution requirement published |
| [MTA GTFS (subway)](http://web.mta.info/developers/data-nyct-subway.html) | Station locations + full timetable | Free zip download | MTA Developer Data Terms of Use (free use, attribution requested) |
| [PATH GTFS](https://www.panynj.gov/path/en/schedules-maps/gtfs-realtime.html) (served via Trillium Transit) | Station locations + full timetable for the 13 PATH stations | Free zip download | Published by the Port Authority as open transit data |
| [Overture Maps Places](https://overturemaps.org/) | POIs (name, category, location) for all of NYC | Free, keyless Parquet-over-S3, queried with DuckDB | See [overturemaps.org/data](https://overturemaps.org/data) for the current per-theme license and attribution requirements before any public-facing use |
| [NYC 311 Service Requests](https://data.cityofnewyork.us/d/erm2-nwe9) | Noise complaint counts near an address, trailing 12 months | Free Socrata REST API, paginated | NYC Open Data Terms of Use -- public data, generally free to reuse |
| [NYC HPD Housing Maintenance Code Violations](https://data.cityofnewyork.us/d/wvxf-dwi5) | Open violations by class (Class C = immediately hazardous) for a building's BBL | Free Socrata REST API | NYC Open Data Terms of Use |
| [NYC PLUTO](https://data.cityofnewyork.us/d/64uk-42ks) | Year built, per tax lot | Free Socrata REST API | NYC Open Data Terms of Use |
| [NYC Street Tree Census](https://data.cityofnewyork.us/d/uvpi-gqnh) (2015) | Living street tree counts near an address | Free Socrata REST API | NYC Open Data Terms of Use |
| [NYC Police Precinct boundaries](https://data.cityofnewyork.us/resource/y76i-bdw7.geojson) | Point-in-polygon precinct lookup | Free Socrata GeoJSON export | NYC Open Data Terms of Use |
| [NYPD CompStat](https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page) | Per-precinct YTD robbery / felony assault / total major crime | Public PDF, requires a browser User-Agent (bot-UA block, not auth) | Public NYPD statistical release |

## Known simplifications

Stated honestly, on purpose -- an engineer reading this code should respect
a stated simplification and distrust a hidden one.

- **Transit times are in-vehicle plus a nominal transfer penalty. They
  exclude the origin walk and the platform wait.** Concretely: median
  inter-station ride time from the real GTFS timetable, plus a flat 240s
  (4-minute) transfer penalty, not headway-aware RAPTOR-style routing --
  it doesn't know train frequency, time of day, or that PATH runs far less
  often than the subway off-peak. **They are a floor, not a door-to-door
  estimate.** A computed number can read a little optimistic versus a real
  commute, especially across a subway<->PATH transfer. (The UI's own
  `transit.caveat` field says this in plain language, not just this file.)
- **Amenity counts use an H3 k-ring (~10-minute walk), not a true
  walk-network isochrone.** A k-ring (the address's res-9 cell plus its
  six neighbours) is roughly a 10-minute walk in open street grids, but
  it's a hex disk, not the actual reachable street network -- it can over-
  or under-count near rivers, parks, highways, or anywhere the walkable
  network doesn't match a regular hex tiling.
- **Claim extraction is rule-based regex, not an LLM.** `factcheck.py`
  matches a curated list of real-estate marketing phrases against the
  listing text with regex. This is deterministic and needs no API key or
  network call -- and it only catches phrases it already knows about. A
  listing that says "hushed" instead of "quiet," or phrases the list's
  author never thought of, produce no claim at all rather than a wrong
  one, which is the safer failure direction for this project but is still
  a real coverage gap worth naming.
- **Sunlight and renovation-permit checks are not built.** "Sun-drenched"
  would need building footprints, heights, and real solar geometry;
  "newly renovated" would need DOB permit filings ingested and matched.
  Neither exists yet. The fact-checker returns `no_data` for both,
  honestly, with a citation to the real dataset that *would* answer it --
  never a guess dressed up as an answer.
- **Building age is a signal, not a promise.** Pre-war housing stock
  *often* carries rent-stabilised units; it does not guarantee one, and
  the UI's own `era_note` text says exactly that rather than implying a
  cheap apartment is available just because a building is old.
- **`safety` is YTD counts for exactly two crime categories** (robbery,
  felony assault) plus a total, from the most recent weekly CompStat PDF.
  It is not a comprehensive crime picture, and "total" includes categories
  (burglary, grand larceny, etc.) not broken out individually.
- **The geocoder's fuzzy-match guard is a heuristic, not a proof.** NYC
  GeoSearch's PAD index is NYC-only, so an out-of-city address doesn't
  fail -- it fuzzy-matches a same-numbered NYC address on an unrelated
  street. `geocode.py` catches this by comparing the *identity* of the
  requested and matched street names (stripped of suffix/direction-word
  abbreviation noise), which reliably rejects a mismatch like "1313
  Disneyland Dr, Anaheim" -> "1313 Shore Drive, Bronx" (confirmed live).
  It can still be fooled by two genuinely different streets that happen to
  share a non-generic word (e.g. "Infinite Loop" vs. "Ash Loop") -- a real
  residual gap, not a claim of a solved problem.
- **Disk caches (POI table, anchor times, both GTFS zips, CompStat PDFs,
  precinct boundaries) never auto-refresh.** Deleting the file under
  `data/` is still how you force a refetch. What changed: serving a cache
  past a documented freshness window now emits a loud `StaleCacheWarning`
  (`bearings/staleness.py`) instead of silently serving arbitrarily old
  data forever with nothing on screen or in the logs saying so.

## The rule that governs the output

**Report the data. Never render a verdict.** Every claim in the
fact-checker's response carries a sourced, factual `evidence` string --
`"72 open Class C (immediately hazardous) HPD violations on record for
this building"` -- and a `status` that is a *data-driven* classification
(does the number agree with the claim or not), never an editorial one.
Nothing in this codebase's output ever says "misleading," "a scam," or
"this landlord is lying." Truth is an absolute defense against
defamation, and sourced public data is true; editorialising is where all
the legal risk lives, and the cited number is more damning than any
adjective anyway. This applies to the API responses, to the UI copy, and
to this README.

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
  api.py                # FastAPI wrapper: GET /api/profile, POST /api/factcheck
  cli.py                 # `bearings profile "<address>"`
  factcheck.py           # rule-based claim extraction + evidence lookup

web/                    # React + TypeScript front end (Phase 2) -- see "Running
                         # the front end" above
  src/
    App.tsx               # top-level state: address, profile, fact-check
    api.ts                # typed fetch wrapper for the two endpoints
    types.ts               # mirrors the API contract exactly
    components/             # one component per report field + the fact-checker
    styles/index.css         # the whole design system, hand-written CSS
```
