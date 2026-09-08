"""Generic NYC Open Data (SODA) client with pagination.

SODA hard-caps a single response at 50,000 rows regardless of what you ask
for, so anything larger has to be paged. This is the only place in the
codebase that knows that.

Retries transient failures (connection/read/protocol errors, 429/502/503/
504) with backoff. This is not a workaround for slow code -- it's a
response to Socrata itself being intermittently slow or flaky. Confirmed
live 2026-07-18: a `within_circle` count query against the 311 dataset
(tens of millions of rows) hit `httpx.ReadTimeout` at exactly the 120s
ceiling in a CI run, with no other symptom -- the identical query succeeds
in under a second on a normal call (see test_noise.py). One retry against
a fresh connection is the right response to a stalled/hung read like that;
doubling the timeout further would not have helped a query that appears to
have simply stalled, and this project's own "no mocking" rule means the
test suite has to tolerate that Socrata occasionally does this, not paper
over it with a fake. Scoped to `httpx.TransportError` rather than only
`httpx.TimeoutException` after an ad-hoc live check against a real
always-503 endpoint came back as `RemoteProtocolError` (a connection-level
failure, not a timeout) -- both are httpx.TransportError subclasses
(confirmed via httpx's own exception `__mro__`), and both are the same
"the network misbehaved this one time" class this retry exists for."""

import time

import httpx
import pandas as pd

from bearings import config

PAGE = 50_000

_MAX_ATTEMPTS = 3
_RETRY_BACKOFF_S = 3.0
_RETRYABLE_STATUS = {429, 502, 503, 504}
# The read timeout every bake-path caller has always used, named rather than
# left as a literal now that it is overridable (see _get_with_retry below).
TIMEOUT_S = 120.0


def _get_with_retry(
    url: str,
    params: dict,
    *,
    timeout: float = TIMEOUT_S,
    attempts: int = _MAX_ATTEMPTS,
    retry_backoff_s: float = _RETRY_BACKOFF_S,
) -> httpx.Response:
    """GET with retry-on-transient-failure.

    Retries `httpx.TransportError` (covers ReadTimeout/ConnectTimeout/
    WriteTimeout/PoolTimeout, plus connection-level failures like
    ConnectError/RemoteProtocolError) and the classic "server is
    overloaded, try again" status codes. Does NOT retry on 4xx client
    errors (bad dataset key, malformed $where, etc.) -- those are real
    code defects and should fail immediately, not be masked by a retry
    loop.

    `timeout`/`attempts`/`retry_backoff_s` default to exactly the values
    this function has always used, so every existing caller behaves
    identically. They exist for the one caller that runs on a *request*
    path rather than a bake path -- bearings.buildingrecord, which serves
    live per-building sources behind a hard 3s deadline and needs the
    socket itself bounded, not just the future it waits on. A 120s read
    timeout inside a 3s budget would leave a worker thread running long
    after the response it belongs to has already been sent, which on a
    512MB Render instance is a real leak, not a theoretical one.
    """
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            resp = httpx.get(url, params=params, timeout=timeout)
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt == attempts - 1:
                raise
            time.sleep(retry_backoff_s * (attempt + 1))
            continue

        if resp.status_code in _RETRYABLE_STATUS and attempt < attempts - 1:
            time.sleep(retry_backoff_s * (attempt + 1))
            continue

        resp.raise_for_status()
        return resp

    assert last_exc is not None  # pragma: no cover -- loop always returns or raises
    raise last_exc


def fetch(
    dataset_key: str,
    *,
    select: str | None = None,
    where: str | None = None,
    limit: int | None = None,
    order: str | None = None,
    timeout: float = TIMEOUT_S,
    attempts: int = _MAX_ATTEMPTS,
    retry_backoff_s: float = _RETRY_BACKOFF_S,
) -> pd.DataFrame:
    """Fetch a NYC Open Data set as a DataFrame.

    `dataset_key` is a key of config.SOCRATA_DATASETS, not a raw 4x4.

    `order` is passed straight through as SODA's `$order`. **Pass
    `order=":id"` for any multi-page fetch whose result is baked to disk.**
    SODA does not guarantee a stable row order across pages when none is
    given, so a plain `$limit`/`$offset` walk can serve the same row on two
    consecutive pages -- and, as the mirror image of that, silently skip a
    row that shifted the other way. That is not hypothetical here: it is
    the measured cause of the duplicate rows in this repo's own baked
    building/street files (2026-09-07). data/derived/buildings.parquet,
    baked 2026-07-14, carried 314 exact-duplicate rows out of 1,079,572
    (0.029%), and 626 of the 628 rows involved sat in one contiguous run at
    file positions 149,686-150,324 -- straddling the `$offset=150000` page
    boundary exactly. data/derived/streets.parquet carried 1,118 duplicates
    out of 135,266 (0.827%) in the same shape. One of those duplicated
    footprints (base_bbl 1008380069) was re-queried live on 2026-09-07 and
    the dataset returns exactly ONE row for it, confirming the second copy
    was a pagination artefact and never a real second building.

    Left `None` by default rather than always ordering: `$order=:id` costs
    a little on the server (2.30s vs 1.76s for a real 5-row page at
    `$offset=149998` against the building dataset, measured live
    2026-09-07), and the callers that fetch a single page, or that
    client-aggregate a whole dataset into counts where row identity does
    not matter, do not need it.

    `timeout`/`attempts`/`retry_backoff_s` pass straight through to
    `_get_with_retry` and default to its own long-standing bake-path
    values -- see that function's docstring for the one request-path
    caller they exist for.
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
        if order:
            params["$order"] = order

        resp = _get_with_retry(
            url,
            params,
            timeout=timeout,
            attempts=attempts,
            retry_backoff_s=retry_backoff_s,
        )
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
