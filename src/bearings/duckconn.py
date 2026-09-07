"""One place that opens a DuckDB connection for a *request-path* query.

**Why this module exists, measured rather than assumed (2026-09-07).**
Every per-request reader in this codebase -- the map's building, street,
subway-shape and station bbox slices, the reach endpoint's POI slice --
opens its own `duckdb.connect()` and closes it again. That is correct and
cheap in itself (a bare connect costs ~35MB and no file is held open
between requests). What is not cheap is what DuckDB *defaults to* inside a
memory-capped container:

  - `threads` defaults to the machine's core count. DuckDB reads the host's
    CPU count, not the container's CPU share, so a Render free instance
    (0.1 CPU) or a `docker run` with no `--cpus` on a 22-thread laptop both
    get `threads=22`.
  - `memory_limit` defaults to ~80% of the memory DuckDB detects, and
    DuckDB *does* read the cgroup: in a `docker run --memory=512m`
    container it resolves to 409.5 MiB, confirmed live 2026-09-07 by
    reading `current_setting('memory_limit')` inside the real image.

Those two defaults multiply. Measured 2026-09-07 in a real
`docker run --memory=512m --memory-swap=512m` container, running
buildings.footprints_in_bbox()'s exact query for one real midtown bbox
(2,045 matching footprints, LEFT JOINed against the 858,602-row
building_attributes.parquet):

    threads=22 (DuckDB's default)  -> OutOfMemoryException:
                                      "failed to allocate data of size
                                      128.0 KiB (409.4 MiB/409.5 MiB used)"
    threads=1                      -> 2,045 rows in 0.30s, no error
    threads=2, memory_limit=192MB  -> 2,045 rows in 0.20s, no error

The failure is a *reservation* failure, not real memory exhaustion: the
container's own cgroup anon high-water sat at ~170MB through every one of
those runs. DuckDB reserves per-thread buffers against its own limit and
refuses the query long before the kernel is under any pressure. With 22
threads that reservation alone exceeds the whole 409.5 MiB budget, and
three concurrent requests each do it independently -- which is how the
un-tuned image gets its container OOM-killed (exit 137) under three
concurrent light-browsing clients.

`threads=2` rather than 1: on Render's free (0.1 CPU) and starter (0.5 CPU)
plans there is no real parallelism to win beyond a couple of threads
anyway, and keeping two leaves DuckDB able to overlap a scan with a join
without reserving eleven times more than it can use.

Deliberately NOT applied to the bake-time connections (sources/*.py's
`_write_parquet`, cellprofile.py's citywide precompute). Those run at
`docker build`, where there is no request-latency clock, no concurrency,
and a much larger memory allowance -- exactly the place where DuckDB's
"use the whole machine" defaults are the right ones.
"""

import duckdb

# See the module docstring for the measurement behind this number.
REQUEST_THREADS = 2


def connect() -> duckdb.DuckDBPyConnection:
    """A DuckDB connection sized for a single web request.

    Sets `threads` only. `memory_limit` is deliberately left at DuckDB's own
    cgroup-derived default: that default is *correct* (it is what makes
    DuckDB refuse rather than get the container OOM-killed), and pinning a
    number here would silently stop tracking whatever plan the service is
    actually running on.
    """
    return duckdb.connect(config={"threads": REQUEST_THREADS})
