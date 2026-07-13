"""311 noise complaints near a point.

Noise complaint types all start with "Noise" -- confirmed live via
`$select=distinct complaint_type`: "Noise", "Noise - Commercial",
"Noise - Helicopter", "Noise - House of Worship", "Noise - Park",
"Noise - Residential", "Noise - Street/Sidewalk", "Noise - Vehicle".

The 311 dataset carries a genuine Socrata Point column named `location`,
so `within_circle(location, lat, lng, radius)` runs server-side -- confirmed
live (HTTP 200, correct counts). This dataset is tens of millions of rows;
never fetch it unfiltered."""

from datetime import datetime, timedelta, timezone

from bearings.sources import socrata

SOURCE = {"name": "NYC 311", "url": "https://data.cityofnewyork.us/d/erm2-nwe9"}

_WINDOW_DAYS = 365


def complaints_near(lat: float, lng: float, radius_m: float = 400) -> int:
    """Count of 311 noise complaints within `radius_m` metres of a point,
    filed in the trailing 12 months."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_WINDOW_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    where = (
        f"complaint_type like 'Noise%' "
        f"AND created_date > '{cutoff}' "
        f"AND within_circle(location, {lat}, {lng}, {radius_m})"
    )
    df = socrata.fetch("311", select="count(*)", where=where)
    if df.empty:
        return 0
    return int(df.iloc[0]["count"])
