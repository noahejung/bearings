"""MTA subway GTFS ingest.

GTFS is a zip of CSVs. We need three of them:
  stops.txt      - station and platform locations
  stop_times.txt - the actual timetable (this is the good part)
  trips.txt      - maps a trip to a route
"""

import io
import zipfile
from pathlib import Path

import httpx
import pandas as pd

from bearings import cells, config

_ZIP = "google_transit.zip"


def download() -> Path:
    """Fetch the GTFS zip, caching it in RAW_DIR."""
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.RAW_DIR / _ZIP

    if dest.exists():
        return dest

    resp = httpx.get(config.MTA_GTFS_URL, timeout=120.0, follow_redirects=True)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def _read(name: str) -> pd.DataFrame:
    with zipfile.ZipFile(download()) as z:
        with z.open(name) as f:
            return pd.read_csv(io.BytesIO(f.read()))


def _hhmmss_to_seconds(s: str) -> int:
    """GTFS times can exceed 24h ('25:10:00' = 1:10am the next service day),
    so we cannot use a normal time parser."""
    h, m, sec = (int(p) for p in s.split(":"))
    return h * 3600 + m * 60 + sec


def stations() -> pd.DataFrame:
    """One row per *station*, not per platform.

    MTA stop_ids carry a direction suffix: 127N and 127S are the north and
    south platforms of station 127. stops.txt links them via parent_station.
    Collapsing to the parent is mandatory — skip it and every station in the
    system is counted twice.
    """
    stops = _read("stops.txt")
    trips = _read("trips.txt")
    times = _read("stop_times.txt")

    # location_type 1 == a station (as opposed to a platform).
    parents = stops[stops["location_type"] == 1][
        ["stop_id", "stop_name", "stop_lat", "stop_lon"]
    ].copy()

    # Map every platform to its parent station.
    platforms = stops[stops["parent_station"].notna()][["stop_id", "parent_station"]]

    # Which routes serve which platform -> roll up to the parent station.
    trip_routes = trips[["trip_id", "route_id"]]
    served = (
        times[["trip_id", "stop_id"]]
        .drop_duplicates()
        .merge(trip_routes, on="trip_id")
        .merge(platforms, on="stop_id")
        .groupby("parent_station")["route_id"]
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

    return out[["stop_id", "name", "lat", "lng", "cell", "routes"]].reset_index(drop=True)


def stop_times() -> pd.DataFrame:
    """The timetable, with times normalised to seconds-since-midnight and stops
    collapsed to parent stations."""
    stops = _read("stops.txt")
    times = _read("stop_times.txt")

    platform_to_parent = dict(
        zip(stops["stop_id"], stops["parent_station"], strict=True)
    )

    out = times.copy()
    out["stop_id"] = out["stop_id"].map(
        lambda s: platform_to_parent.get(s) or s
    )
    out["arrival"] = out["arrival_time"].map(_hhmmss_to_seconds)
    out["departure"] = out["departure_time"].map(_hhmmss_to_seconds)
    out = out.rename(columns={"stop_sequence": "seq"})

    return out[["trip_id", "stop_id", "arrival", "departure", "seq"]]
