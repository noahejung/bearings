"""Pure H3 helpers. No I/O — every function here is a total function of its
arguments, which is what makes the rest of the pipeline testable."""

import h3

from bearings import config


def cell_for(lat: float, lng: float) -> str:
    """Snap a point to its H3 profile cell."""
    return h3.latlng_to_cell(lat, lng, config.H3_RES)


def neighbors(cell: str, k: int = 1) -> list[str]:
    """The cell plus every cell within k rings of it. Includes `cell` itself."""
    return list(h3.grid_disk(cell, k))


def centroid(cell: str) -> tuple[float, float]:
    """(lat, lng) of the cell's centre."""
    return h3.cell_to_latlng(cell)


def shard_for(cell: str) -> str:
    """The res-6 parent that a profile cell is emitted under."""
    return h3.cell_to_parent(cell, config.SHARD_RES)


def in_nyc(lat: float, lng: float) -> bool:
    b = config.NYC_BBOX
    return b["ymin"] <= lat <= b["ymax"] and b["xmin"] <= lng <= b["xmax"]
