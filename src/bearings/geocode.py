"""Address -> point, via NYC Planning Labs GeoSearch (free, keyless)."""

from dataclasses import dataclass

import httpx

from bearings import cells, config


class GeocodeError(Exception):
    """No usable NYC match for the given address."""


@dataclass(frozen=True)
class GeocodeResult:
    label: str
    lat: float
    lng: float
    bbl: str | None


def geocode(address: str) -> GeocodeResult:
    resp = httpx.get(
        config.GEOSEARCH_URL,
        params={"text": address, "size": 1},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    features = body.get("features", [])

    if not features:
        raise GeocodeError(f"No match for {address!r}")

    feat = features[0]
    lng, lat = feat["geometry"]["coordinates"]

    if not cells.in_nyc(lat, lng):
        raise GeocodeError(f"{address!r} resolved to ({lat}, {lng}), outside NYC")

    props = feat.get("properties", {})

    # GeoSearch's index (NYC's PAD) contains only NYC addresses, so an
    # out-of-NYC query never comes back with an out-of-bbox coordinate -- it
    # fuzzy-matches to a same-named NYC street instead (match_type
    # "fallback"), frequently at a different house number on that street.
    # A house-number mismatch against what was actually asked for is the real
    # signal that this wasn't a genuine match; the bbox check alone cannot
    # catch this because every candidate GeoSearch can return is in NYC.
    parsed = body.get("geocoding", {}).get("query", {}).get("parsed_text", {})
    query_housenumber = parsed.get("housenumber")
    result_housenumber = props.get("housenumber")
    if (
        query_housenumber
        and result_housenumber
        and query_housenumber != result_housenumber
    ):
        raise GeocodeError(
            f"{address!r} only fuzzy-matched house number {result_housenumber!r} "
            f"(asked for {query_housenumber!r}) -- treating as no real match"
        )

    bbl = props.get("addendum", {}).get("pad", {}).get("bbl")

    return GeocodeResult(
        label=props.get("label", address),
        lat=lat,
        lng=lng,
        bbl=bbl,
    )
