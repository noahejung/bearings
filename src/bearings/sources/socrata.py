"""Generic NYC Open Data (SODA) client with pagination.

SODA hard-caps a single response at 50,000 rows regardless of what you ask
for, so anything larger has to be paged. This is the only place in the
codebase that knows that."""

import httpx
import pandas as pd

from bearings import config

PAGE = 50_000


def fetch(
    dataset_key: str,
    *,
    select: str | None = None,
    where: str | None = None,
    limit: int | None = None,
) -> pd.DataFrame:
    """Fetch a NYC Open Data set as a DataFrame.

    `dataset_key` is a key of config.SOCRATA_DATASETS, not a raw 4x4.
    """
    dataset_id = config.SOCRATA_DATASETS[dataset_key]  # KeyError on typo, by design
    url = f"https://{config.SOCRATA_DOMAIN}/resource/{dataset_id}.json"

    frames: list[pd.DataFrame] = []
    fetched = 0

    while True:
        want = PAGE if limit is None else min(PAGE, limit - fetched)
        if want <= 0:
            break

        params: dict[str, object] = {"$limit": want, "$offset": fetched}
        if select:
            params["$select"] = select
        if where:
            params["$where"] = where

        resp = httpx.get(url, params=params, timeout=120.0)
        resp.raise_for_status()
        rows = resp.json()

        if not rows:
            break

        frames.append(pd.DataFrame(rows))
        fetched += len(rows)

        # A short page means we've reached the end of the dataset.
        if len(rows) < want:
            break

    if not frames:
        return pd.DataFrame()

    return pd.concat(frames, ignore_index=True)
