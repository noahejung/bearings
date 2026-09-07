"""GTFS ingest, shared between the MTA subway and PATH feeds.

GTFS is a zip of CSVs. We need four of them:
  stops.txt      - station and platform locations
  stop_times.txt - the actual timetable (this is the good part)
  trips.txt      - maps a trip to a route
  routes.txt     - maps a route to its rider-facing short name

Everything that differs between feeds -- the download URL, the cache
filename, and whether IDs need a namespace prefix -- lives in FEEDS below.
The parsing functions never branch on which feed they're looking at.

**Bake vs. per-request (2026-09-07).** stations()/shapes()/shape_routes()
below are honest, but expensive: each one re-opens the zip and re-parses
(and for stations(), re-merges) several CSVs. mapgeo.map_geometry() called
all three on every single GET /api/map request, which measured 1.32s of
every request on a full desktop CPU (0.99s stations + 0.21s shapes and
shape_routes + a 154k-point Python bbox loop) -- pure repeated work against
a file that cannot change inside a process lifetime.

The two derived artefacts the map actually needs are therefore baked to
Parquet once at build time (warm_cache(), called by mapgeo.warm_caches(),
which the Dockerfile already runs at `docker build`) and sliced per request
with DuckDB: SUBWAY_STATIONS_PATH and SUBWAY_SHAPES_PATH, read by
stations_in_bbox() and shape_candidates_in_bbox(). This is the same
bake-once / bbox-slice-per-request pattern sources/buildings.py and
sources/streets.py already use for their own static geodata.

It is deliberately NOT an @lru_cache on the three functions above.
Measured 2026-09-07 against this repo's real feeds: memoising all six
(function, feed) pairs retains +13.23MB resident, ~15.03MB of which is
shapes("mta") alone. Render's free tier caps the whole process at 512MB and
Wave 6h's measured 3-concurrent peak was already 487.7-496.5MB, so a
persistent frame that size would eat most of the remaining headroom --
exactly the failure mode Wave 6h had just finished removing from
profile._pois(). The baked path costs 0MB resident.
"""

import io
import zipfile
from functools import lru_cache
from pathlib import Path

import duckdb
import httpx
import pandas as pd

from bearings import cells, config, duckconn, staleness

FEEDS: dict[str, dict[str, str | None]] = {
    "mta": {
        "url": config.MTA_GTFS_URL,
        "cache_name": "google_transit.zip",
        # No prefix: MTA is the original feed and its stop_ids predate
        # namespacing. Only feeds added after it are prefixed, so a stop_id
        # with no colon is unambiguously MTA.
        "prefix": None,
    },
    "path": {
        "url": config.PATH_GTFS_URL,
        "cache_name": "path-nj-us.zip",
        # PATH's stop_ids are small integers (e.g. 26732) that could
        # collide with MTA's. Namespacing makes a collision structurally
        # impossible rather than merely unlikely.
        "prefix": "PATH:",
    },
}

# Derived, build-time-baked slices of the feeds above -- see this module's
# own "Bake vs. per-request" docstring section for why these exist and why
# an @lru_cache on the raw frames was measured and rejected instead.
SUBWAY_STATIONS_PATH = config.DERIVED_DIR / "subway_stations.parquet"
SUBWAY_SHAPES_PATH = config.DERIVED_DIR / "subway_shapes.parquet"


def _download(feed: str) -> Path:
    """Fetch a feed's GTFS zip, caching it in RAW_DIR."""
    spec = FEEDS[feed]  # KeyError on typo, by design
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.RAW_DIR / spec["cache_name"]

    if dest.exists():
        staleness.warn_if_stale(dest, config.GTFS_CACHE_MAX_AGE_S, f"{feed} GTFS feed")
        return dest

    resp = httpx.get(spec["url"], timeout=120.0, follow_redirects=True)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def _read(feed: str, name: str) -> pd.DataFrame:
    with zipfile.ZipFile(_download(feed)) as z:
        with z.open(name) as f:
            return pd.read_csv(io.BytesIO(f.read()))


def _clean_id(value: object) -> str:
    """Canonicalise a raw GTFS ID to a string.

    MTA's IDs are alphanumeric (e.g. "A36"), so pandas already reads that
    column as strings. PATH's IDs are all-numeric, so pandas reads stop_id
    as int64 but parent_station as float64 -- NaN (for parentless rows)
    forces the whole column to float. Cast blindly with `.astype("string")`
    and the *same* station ends up as "26731" from one path and "26731.0"
    from the other, which silently breaks the stations<->stop_times join
    (ride edges never match a graph node). Always route through here first.
    """
    if isinstance(value, float):
        return str(int(value))
    return str(value)


def _namespaced(feed: str, ids: pd.Series) -> pd.Series:
    """Canonicalise then apply the feed's ID prefix, if it has one."""
    clean = ids.map(_clean_id)
    prefix = FEEDS[feed]["prefix"]
    if not prefix:
        return clean
    return prefix + clean


def _hhmmss_to_seconds(s: str) -> int:
    """GTFS times can exceed 24h ('25:10:00' = 1:10am the next service day),
    so we cannot use a normal time parser."""
    h, m, sec = (int(p) for p in s.split(":"))
    return h * 3600 + m * 60 + sec


def stations(feed: str = "mta") -> pd.DataFrame:
    """One row per *station*, not per platform, for the given feed.

    Every stop_id carries a direction/platform suffix or is a distinct
    platform row entirely; stops.txt links these back to a parent via
    parent_station, and the parent itself is the location_type==1 row.
    Collapsing to the parent is mandatory -- skip it and every station in
    the system is counted once per platform (and, for PATH, once per
    entrance too -- Hoboken alone has three non-platform rows sharing its
    name).

    Dedup key is `stop_id`, not (name, lat, lon). A prior version of this
    function deduped on (stop_name, stop_lat, stop_lon), on the assumption
    that filtering to location_type==1 already gives one row per station
    and that a name+coords dedup was purely defense-in-depth against a
    malformed feed. That assumption is false against the real, live MTA
    feed: three real station complexes legitimately have two distinct
    parent-station rows sharing an identical name and identical
    coordinates, because two different line groups were assigned separate
    parent stop_ids for what riders experience as "one" station --
    confirmed live 2026-07-18 by grouping stops.txt's own location_type==1
    rows:
      - Queensboro Plaza: R09 (N/W's parent stop) and 718 (7/7X's parent
        stop), both at (40.750582, -73.940202).
      - 145 St: A12 (A/C's parent stop) and D13 (B/D's parent stop), both
        at (40.824783, -73.944216).
      - W 4 St-Wash Sq: A32 (A/C/E's parent stop) and D20 (B/D/F/M's
        parent stop), both at (40.732338, -74.000495).
    The old dedup silently kept one of each pair and discarded the other --
    for Queensboro Plaza, discarding R09 removed it as a graph node
    entirely, which severed every ride edge referencing it as source or
    destination, which orphaned all six N/W stations north of it
    (Ditmars Blvd through 39 Av-Dutch Kills) from the whole transit graph.
    `stop_id` is stops.txt's actual primary key (unique per row by the GTFS
    spec, confirmed live: zero duplicate stop_ids among either feed's
    location_type==1 rows) and is what should have been deduped on from the
    start -- two stations that are the *same* row can only share a
    stop_id, never merely a name and a coordinate. Deduping on stop_id
    keeps the original defense-in-depth intent (a feed that ever emits a
    truly duplicate parent row -- the identical stop_id twice -- still
    collapses to one) without discarding a station that is only a
    coordinate-and-name twin of another, distinct, real station.
    """
    stops = _read(feed, "stops.txt")
    trips = _read(feed, "trips.txt")
    times = _read(feed, "stop_times.txt")
    routes = _read(feed, "routes.txt")

    # location_type 1 == a station (as opposed to a platform or entrance).
    parents = (
        stops[stops["location_type"] == 1][
            ["stop_id", "stop_name", "stop_lat", "stop_lon"]
        ]
        .drop_duplicates(subset=["stop_id"])
        .copy()
    )

    # Map every platform/entrance to its parent station.
    platforms = stops[stops["parent_station"].notna()][["stop_id", "parent_station"]]

    # Which routes serve which platform -> roll up to the parent station.
    # Join through routes.txt for route_short_name rather than using
    # route_id directly: for MTA the two are identical ("1" == "1"), but
    # PATH's route_ids are opaque numbers (e.g. "859") while every PATH
    # route's short name is the rider-facing "PATH" -- route_id alone
    # would be meaningless in the profile output.
    trip_routes = trips[["trip_id", "route_id"]].merge(
        routes[["route_id", "route_short_name"]], on="route_id", how="left"
    )
    served = (
        times[["trip_id", "stop_id"]]
        .drop_duplicates()
        .merge(trip_routes, on="trip_id")
        .merge(platforms, on="stop_id")
        .groupby("parent_station")["route_short_name"]
        .apply(lambda s: sorted(set(s)))
        .rename("routes")
    )

    out = parents.merge(
        served, left_on="stop_id", right_index=True, how="left"
    ).rename(columns={"stop_name": "name", "stop_lat": "lat", "stop_lon": "lng"})

    out["routes"] = out["routes"].apply(lambda r: r if isinstance(r, list) else [])
    out["cell"] = [
        cells.cell_for(lat, lng)
        for lat, lng in zip(out["lat"], out["lng"], strict=True)
    ]
    out["stop_id"] = _namespaced(feed, out["stop_id"])

    return out[["stop_id", "name", "lat", "lng", "cell", "routes"]].reset_index(drop=True)


def shapes(feed: str = "mta") -> pd.DataFrame:
    """One row per unique shape_id, coords ordered by shape_pt_sequence as a
    list of (lat, lng) tuples -- the real line geometry a shape_id traces,
    used by the map (VISUAL.md's subway layer). Not collapsed further: a
    route can run several distinct shapes (branches, express skips), and
    drawing every one of them is what makes the map's subway lines match
    the real network rather than a simplified one-line-per-route sketch.
    """
    raw = _read(feed, "shapes.txt").sort_values(["shape_id", "shape_pt_sequence"])

    records = []
    for shape_id, g in raw.groupby("shape_id", sort=False):
        coords = list(zip(g["shape_pt_lat"].tolist(), g["shape_pt_lon"].tolist(), strict=True))
        records.append({"shape_id": shape_id, "coords": coords})

    out = pd.DataFrame.from_records(records, columns=["shape_id", "coords"])
    out["shape_id"] = _namespaced(feed, out["shape_id"])
    return out


def shape_routes(feed: str = "mta") -> dict[str, str]:
    """shape_id -> a real, rider-facing route label (e.g. "B", "PATH") --
    the map's subway-line labels (VISUAL.md §5: "Subway lines + labels ...
    labelled by route"). Joined via trips.txt (shape_id -> route_id) and
    routes.txt (route_id -> route_short_name), the same two-hop join
    stations() already uses for the same reason: PATH's route_ids are
    opaque numbers, route_short_name is the only rider-facing label.

    A shape_id shared by more than one route_short_name (possible in
    principle -- GTFS doesn't forbid it) joins the labels with "/" rather
    than silently picking one, so the label never claims a single-route
    shape is more certain than the data says.
    """
    trips = _read(feed, "trips.txt")
    routes = _read(feed, "routes.txt")
    joined = (
        trips[["shape_id", "route_id"]]
        .dropna()
        .merge(routes[["route_id", "route_short_name"]], on="route_id", how="left")
    )
    joined["shape_id"] = _namespaced(feed, joined["shape_id"])
    grouped = joined.groupby("shape_id")["route_short_name"].apply(
        lambda s: "/".join(sorted(set(s.dropna())))
    )
    return grouped.to_dict()


# ---------------------------------------------------------------------------
# Baked subway geometry for the map's per-request bbox slice.
# ---------------------------------------------------------------------------


def _write_parquet(df: pd.DataFrame, path: Path) -> None:
    """The same DuckDB COPY the sibling geodata bakes use (see
    sources/streets.py's own _write_parquet) so all three baked map layers
    are written the one way."""
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.register("_df", df)
        con.execute(f"COPY _df TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


def _baked_stations_frame() -> pd.DataFrame:
    """Every real station in every feed, in the exact order
    `pd.concat([stations(f) for f in FEEDS], ignore_index=True)` produces
    -- `ord` preserves that order across the Parquet round trip, so a bbox
    slice of the baked file is row-for-row identical to a bbox slice of the
    live parse (which is what the map's station markers already rendered).
    """
    out = pd.concat([stations(feed) for feed in FEEDS], ignore_index=True)
    out = out[["name", "lat", "lng", "routes"]].copy()
    out.insert(0, "ord", range(len(out)))
    return out


def _baked_shapes_frame() -> pd.DataFrame:
    """Every real GTFS shape in every feed, with its rider-facing route
    label already joined on (shape_routes()) and its own min/max lat/lng
    precomputed so DuckDB can prune rows before any Python touches a
    coordinate. `ord` preserves mapgeo._subway_lines()'s own iteration
    order: feed order first, then shapes()' own shape_id order within a
    feed.

    Geometry is stored as two FLAT `lats`/`lngs` LIST<DOUBLE> columns
    rather than one nested `coords` LIST<LIST<DOUBLE>>, and that is a
    measurement, not a style choice. Six concurrent bbox queries against
    this file (the load shape three real users produce, since FastAPI runs
    these sync handlers in a thread pool inside ONE process) measured, in
    isolated processes, peak Working Set: +171.7MB / +150.2MB with a nested
    coords column, +113.1MB / +106.7MB with flat columns, against +216.0MB
    / +235.1MB for the pre-2026-09-07 live-parse path. DuckDB's Python
    conversion of a doubly-nested LIST allocates a large transient buffer
    per query; a single-level LIST does not. Flat was also faster (0.58s vs
    0.93s for the same six queries). Under Render's 512MB cap that
    difference is the whole margin.
    """
    records: list[dict] = []
    for feed in FEEDS:
        routes = shape_routes(feed)
        for row in shapes(feed).itertuples():
            lats = [lat for lat, _ in row.coords]
            lngs = [lng for _, lng in row.coords]
            records.append(
                {
                    "ord": len(records),
                    "shape_id": row.shape_id,
                    "route": routes.get(row.shape_id, ""),
                    "lats": lats,
                    "lngs": lngs,
                    "min_lat": min(lats),
                    "max_lat": max(lats),
                    "min_lng": min(lngs),
                    "max_lng": max(lngs),
                }
            )
    return pd.DataFrame.from_records(
        records,
        columns=[
            "ord",
            "shape_id",
            "route",
            "lats",
            "lngs",
            "min_lat",
            "max_lat",
            "min_lng",
            "max_lng",
        ],
    )


def warm_cache() -> None:
    """Bake data/derived/subway_stations.parquet and subway_shapes.parquet
    if they don't already exist. Called by mapgeo.warm_caches(), which the
    Dockerfile runs at `docker build` time and api.py's ASGI lifespan runs
    at boot -- so no /api/map request ever pays the GTFS parse. Safe to
    call more than once; a no-op once both files exist. Same shape as
    sources/streets.py's warm_cache(), staleness warning included."""
    if SUBWAY_STATIONS_PATH.exists() and SUBWAY_SHAPES_PATH.exists():
        staleness.warn_if_stale(
            SUBWAY_STATIONS_PATH, config.GTFS_CACHE_MAX_AGE_S, "baked subway stations"
        )
        staleness.warn_if_stale(
            SUBWAY_SHAPES_PATH, config.GTFS_CACHE_MAX_AGE_S, "baked subway shapes"
        )
        return
    _write_parquet(_baked_stations_frame(), SUBWAY_STATIONS_PATH)
    _write_parquet(_baked_shapes_frame(), SUBWAY_SHAPES_PATH)


def _not_baked(path: Path) -> FileNotFoundError:
    return FileNotFoundError(
        f"{path} has not been baked yet -- call bearings.sources.gtfs."
        "warm_cache() first (mapgeo.warm_caches() does this; the Dockerfile's "
        "build-time step and api.py's startup handler both call that). Loud "
        "on purpose: an unbaked subway layer must never come back as an "
        "empty one."
    )


def stations_in_bbox(bbox: dict) -> list[dict]:
    """Every real station inside `bbox`, as {"name", "lat", "lng",
    "routes"} -- a DuckDB slice of the baked table, row for row identical
    to filtering the live parse the same way."""
    if not SUBWAY_STATIONS_PATH.exists():
        raise _not_baked(SUBWAY_STATIONS_PATH)
    con = duckconn.connect()
    try:
        rows = con.execute(
            f"""
            SELECT name, lat, lng, routes
            FROM read_parquet('{SUBWAY_STATIONS_PATH.as_posix()}')
            WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
            ORDER BY ord
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {"name": name, "lat": float(lat), "lng": float(lng), "routes": list(routes)}
        for name, lat, lng, routes in rows
    ]


def shape_candidates_in_bbox(bbox: dict) -> list[dict]:
    """Every baked shape whose OWN bounding box overlaps `bbox`, as
    {"shape_id", "route", "coords"} in mapgeo._subway_lines()'s original
    order.

    Deliberately a SUPERSET, not the answer: a shape whose bbox overlaps
    can still have every one of its vertices outside `bbox` (subway shapes
    are long and diagonal). The exact "does this line actually pass through
    the box" test stays where it already was and already had coverage --
    mapgeo._shape_touches_bbox() -- rather than being re-implemented in SQL
    where the two could drift apart. A bbox-overlap prefilter can only ever
    contain more rows than the vertex test, never fewer (one vertex inside
    the box forces that row's own min/max to straddle the box on both
    axes), so nothing real is lost; what it buys is that the per-point
    Python loop runs over a handful of candidate lines instead of every
    baked point in both feeds. (Measured for one real midtown bbox on
    2026-09-07: 295 baked shapes, 228 candidates, 223 genuinely touching --
    a near-exact prefilter here, because subway shapes are long enough that
    a bbox overlap almost always means a real crossing.)

    `strict=True` on the lats/lngs zip is deliberate: the two flat columns
    are written from the same coordinate list and must stay the same
    length, so a silent truncation to the shorter of the two would draw a
    real subway line short rather than fail.
    """
    if not SUBWAY_SHAPES_PATH.exists():
        raise _not_baked(SUBWAY_SHAPES_PATH)
    con = duckconn.connect()
    try:
        rows = con.execute(
            f"""
            SELECT shape_id, route, lats, lngs
            FROM read_parquet('{SUBWAY_SHAPES_PATH.as_posix()}')
            WHERE max_lat >= ? AND min_lat <= ? AND max_lng >= ? AND min_lng <= ?
            ORDER BY ord
            """,
            [bbox["south"], bbox["north"], bbox["west"], bbox["east"]],
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "shape_id": shape_id,
            "route": route,
            "coords": [[float(a), float(b)] for a, b in zip(lats, lngs, strict=True)],
        }
        for shape_id, route, lats, lngs in rows
    ]


def feed_for_stop(stop_id: str) -> str:
    """Which FEEDS key a namespaced stop_id belongs to, by its prefix --
    the same table `_namespaced()` applies, reversed. Used by Wave 4's
    route-line/directions feature (transit.py's graph nodes are namespaced
    stop_ids with no feed of their own attached, but resolving a "ride"
    edge back to a real GTFS trip/route/shape needs to know which feed's
    stop_times.txt to look in). MTA has no prefix and is listed second in
    FEEDS below -- fine as the fallback, by the same "no prefix == predates
    namespacing" rule FEEDS' own comment states: a stop_id matching no
    OTHER feed's prefix is MTA."""
    for feed, spec in FEEDS.items():
        prefix = spec["prefix"]
        if prefix and stop_id.startswith(prefix):
            return feed
    return "mta"


@lru_cache(maxsize=None)
def _hop_routes(feed: str) -> dict[tuple[str, str], dict]:
    """(src_stop_id, dst_stop_id) -> {route, shape_id, headsign} for every
    real adjacent-stop pair this feed's timetable ever produces, built once
    and memoised.

    transit.py's own `_ride_times()` computes a MEDIAN seconds per (src,
    dst) pair across every trip that makes that hop, deliberately
    discarding which trip(s) produced it -- correct for a travel-time
    estimate, useless for "which real line is this." This is the sibling
    lookup Wave 4's route-line/directions feature needs instead: the FIRST
    real trip found for a given adjacent pair, kept for its route label and
    shape_id. Multiple trips serving the same adjacent pair (local/express
    sharing track) are assumed to belong to the same rider-facing route
    family -- picking one is enough to draw and name the real line ridden,
    not a synthesized one; nothing here invents a pair that isn't a real,
    scheduled adjacency in this feed's own stop_times.txt.
    """
    st = stop_times(feed).sort_values(["trip_id", "seq"])
    st = st.copy()
    st["next_stop"] = st.groupby("trip_id")["stop_id"].shift(-1)
    legs = st.dropna(subset=["next_stop"])
    first = legs.drop_duplicates(subset=["stop_id", "next_stop"], keep="first")

    trips = _read(feed, "trips.txt")[["trip_id", "route_id", "shape_id", "trip_headsign"]]
    routes = _read(feed, "routes.txt")[["route_id", "route_short_name"]]
    joined = first.merge(trips, on="trip_id", how="left").merge(routes, on="route_id", how="left")
    joined["shape_id"] = _namespaced(feed, joined["shape_id"])

    out: dict[tuple[str, str], dict] = {}
    for row in joined.itertuples():
        out[(row.stop_id, row.next_stop)] = {
            "route": row.route_short_name if pd.notna(row.route_short_name) else None,
            "shape_id": row.shape_id if pd.notna(row.shape_id) else None,
            "headsign": row.trip_headsign if pd.notna(row.trip_headsign) else None,
        }
    return out


def route_for_hop(feed: str, src_stop_id: str, dst_stop_id: str) -> dict | None:
    """{"route", "shape_id", "headsign"} for a real trip that rides
    directly from `src_stop_id` to `dst_stop_id` (dst is the immediate next
    stop after src on that trip) in `feed`'s own timetable -- or None if no
    trip in this feed makes that exact adjacent hop (should not happen for
    a "ride" edge transit.py's own graph produced, since that edge exists
    only because SOME trip did; returning None instead of raising keeps a
    route-line/directions request over this one honest caveat rather than
    a 500)."""
    return _hop_routes(feed).get((src_stop_id, dst_stop_id))


def stop_times(feed: str = "mta") -> pd.DataFrame:
    """The timetable for the given feed, with times normalised to
    seconds-since-midnight and stops collapsed to (namespaced) parent
    stations."""
    stops = _read(feed, "stops.txt")
    times = _read(feed, "stop_times.txt")

    platform_to_parent = dict(
        zip(stops["stop_id"], stops["parent_station"], strict=True)
    )

    out = times.copy()
    out["stop_id"] = out["stop_id"].map(
        lambda s: platform_to_parent.get(s) or s
    )
    out["stop_id"] = _namespaced(feed, out["stop_id"])
    out["arrival"] = out["arrival_time"].map(_hhmmss_to_seconds)
    out["departure"] = out["departure_time"].map(_hhmmss_to_seconds)
    out = out.rename(columns={"stop_sequence": "seq"})

    return out[["trip_id", "stop_id", "arrival", "departure", "seq"]]
