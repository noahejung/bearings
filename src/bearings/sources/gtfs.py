"""GTFS ingest, shared between the MTA subway and PATH feeds.

GTFS is a zip of CSVs. We need four of them:
  stops.txt      - station and platform locations
  stop_times.txt - the actual timetable (this is the good part)
  trips.txt      - maps a trip to a route
  routes.txt     - maps a route to its rider-facing short name

Everything that differs between feeds -- the download URL, the cache
filename, and whether IDs need a namespace prefix -- lives in FEEDS below.
The parsing functions never branch on which feed they're looking at.
"""

import io
import zipfile
from pathlib import Path

import httpx
import pandas as pd

from bearings import cells, config

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


def _download(feed: str) -> Path:
    """Fetch a feed's GTFS zip, caching it in RAW_DIR."""
    spec = FEEDS[feed]  # KeyError on typo, by design
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.RAW_DIR / spec["cache_name"]

    if dest.exists():
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
    name). Filtering to location_type==1 already gives one row per station,
    so no additional name+coords dedup is needed for either feed; the
    dedup subset dropna guard below is defense-in-depth against a feed that
    ever emits a duplicate parent row.
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
        .drop_duplicates(subset=["stop_name", "stop_lat", "stop_lon"])
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
