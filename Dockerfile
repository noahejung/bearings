# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1: build the frontend (web/dist -- what api.py's StaticFiles mount
# serves at "/", see src/bearings/api.py).
# ============================================================================
FROM node:20-slim AS frontend-build
WORKDIR /app/web

# Dependency layer separate from source, so editing a .tsx file doesn't
# invalidate npm ci's cache.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build
# -> /app/web/dist (index.html + hashed assets), copied into the runtime
# stage below. See README.md's "Running the front end" for the same build
# the local dev flow ends with.


# ============================================================================
# Stage 2: runtime image.
# ============================================================================
FROM python:3.12-slim AS runtime

# poppler-utils: bearings.sources.compstat shells out to `pdftotext -raw`
# (see that module's docstring -- it must run in -raw mode, not -layout, or
# CompStat's column alignment breaks) to parse NYPD's per-precinct crime PDFs.
# This is an OS binary, not a Python package -- `uv sync` succeeds with or
# without it, and the failure mode without it is silent until the first
# request that needs a *new* (not-yet-cached) precinct's safety block, which
# then throws FileNotFoundError from subprocess.run(["pdftotext", ...]) and
# 500s. On the dev machine this shipped by accident (Git for Windows bundles
# pdftotext); a container has no such accident to lean on, so it is
# installed explicitly here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Official static uv binary -- pinned to the same version this repo's CI
# workflow uses (.github/workflows/ci.yml), so "it passed in CI" and "it
# built in Docker" mean the same uv behaviour.
COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /uvx /usr/local/bin/

WORKDIR /app

# Dependency layer first (pyproject.toml + uv.lock only), so editing
# application source doesn't bust the dependency-install cache on rebuild.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Now the actual package source (bearings is an editable/src-layout
# install -- see uv.lock's `source = { editable = "." }` -- so config.py's
# DATA_DIR, computed as `Path(__file__).resolve().parents[2] / "data"`,
# resolves to /app/data as long as this stays a source checkout at /app
# rather than an installed wheel in site-packages. Do not switch this to
# `pip install .` / a built wheel without re-deriving that path.).
COPY src/ ./src/
COPY README.md ./
RUN uv sync --frozen --no-dev

# The built frontend from stage 1 -- api.py mounts this at "/" if present.
COPY --from=frontend-build /app/web/dist ./web/dist

# ----------------------------------------------------------------------
# Bake the derived data artifacts at BUILD time, not container-boot time.
#
# profile.warm_caches() -- the same call api.py's ASGI lifespan makes on
# every process start (src/bearings/api.py's `lifespan()`) -- is a real
# ~40-120s cold-boot cost the first time it runs in a given data/
# directory: Overture Places over S3 for the whole NYC bounding box
# (~478k rows, ~15MB as Parquet), both GTFS feeds (MTA + PATH, ~6.8MB
# combined), and a full Dijkstra run from all four commute anchors over
# the resulting transit graph. uvicorn will not open its listening socket
# until that finishes, because warm_caches() runs inside the ASGI
# lifespan startup handler by design (api.py's own docstring: "if that
# happened inside the first HTTP request, the demo would look broken").
#
# That tradeoff is fine for a long-lived local dev process that pays the
# cost once, ever. It is NOT fine for a container: most free/hobby PaaS
# tiers restart the container on every deploy, and several (Render's free
# web services, Fly.io's shared-cpu free allowance) scale it to zero after
# a period of inactivity and cold-start it again on the next request. A
# 40-120s blocking startup risks tripping the platform's own boot /
# health-check timeout (commonly 30-60s) and getting the container killed
# mid-boot -- which looks like a crash loop, not a slow deploy, and is
# exactly the kind of silent failure this project's own guard-over-guess
# principle exists to prevent.
#
# So: run warm_caches() here, during `docker build`, where there is no
# boot-timeout clock running and a failure just fails the build (loud, at
# the right time) rather than crash-looping a live container. The result
# -- data/derived/pois.parquet, data/derived/anchor_times.json, both
# cached GTFS zips under data/raw/, and DuckDB's spatial/httpfs extension
# binaries -- lands in this image layer. At container boot, profile.py's
# _pois() and _anchor_times() find their cache files already on disk (see
# profile.py: "the first call in the data directory's lifetime pays the
# real cost... every call after that... loads it back in milliseconds")
# and skip straight to the warm-boot path (~5s, confirmed live
# 2026-07-14), with zero network calls at container start.
#
# Tradeoff, stated plainly: the POI/GTFS snapshot baked into the image is
# only as fresh as the last image build -- a new Overture release or a
# GTFS schedule change needs a rebuild (`docker build` again) to show up.
# That is the same tradeoff the local dev data/ directory already carries
# (config.py's own POI_CACHE_MAX_AGE_S / GTFS_CACHE_MAX_AGE_S are 30-day
# windows that only ever produce a loud warning, never a forced refetch --
# see bearings.staleness). Baking at build time just moves that same
# write-once step earlier, into the build pipeline, instead of onto the
# first container boot.
#
# NOT baked here: NYPD CompStat PDFs (data/raw/pct*.pdf) and the precinct
# boundary GeoJSON (data/raw/precincts.geojson). Neither is part of
# warm_caches() -- both are fetched lazily, per-precinct, inside a real
# request's safety block (see profile.py's _crime() / _safety() and
# sources/precincts.py's _con()) -- so the very first request that touches
# a not-yet-cached precinct pays a few real seconds fetching + (for
# CompStat) running pdftotext on a live NYPD PDF. That is intentional and
# unchanged from local dev's own behaviour, not a gap introduced by this
# Dockerfile.
# ----------------------------------------------------------------------
RUN uv run python -c "from bearings import profile; profile.warm_caches()"

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000

CMD ["uv", "run", "uvicorn", "bearings.api:app", "--host", "0.0.0.0", "--port", "8000"]
