"""Wikimedia Commons -- a freely-licensed photo cataloged near a point, or
an honest nothing.

SPEC-building-card-v2.md Part B. The building click-card can show a
photograph when one exists, hotlinked from Commons' own thumbnail service
with its own attribution, and says so plainly when one does not. Nothing is
downloaded and nothing is stored: the card renders Commons' `thumburl`
directly, which is what Wikimedia's own thumbnail CDN is for.

What was verified live before any of this was written (2026-09-07)
=================================================================
Every mechanic below was confirmed against the real API, not taken from the
dispatch or the spec:

* **One request, not two.** The spec described `list=geosearch` followed by
  a second `prop=imageinfo` call on the returned titles. `generator=geosearch`
  does both in one round trip, which matters inside a 2s budget: the two-call
  form measured 1.53s + 0.09s, the generator form 0.67-1.13s total.

* **The generator does NOT preserve distance order, and it drops `dist`.**
  Measured: the same three Empire State Building files come back with
  `index` -1, 0, 1 in an order unrelated to distance, and none of them
  carries the `dist` field `list=geosearch` returns. So distance is
  recovered explicitly by `prop=coordinates&codistancefrompoint=<lat>|<lng>`,
  whose `dist` reproduces `list=geosearch`'s own numbers exactly (1.2 / 2.2 /
  2.4 m on the same three files). `coprimary=all` is load-bearing: geosearch
  matches a file on ANY of its coordinates, but `prop=coordinates` returns
  only the primary one by default, so a file matched on a secondary
  coordinate would otherwise report the distance to somewhere else entirely.

* **`thumbwidth`/`thumbheight` are the requested box, not the bytes served.**
  Asking `iiurlwidth=480` returns `thumbwidth: 480, thumbheight: 715` and a
  URL ending `500px-...`, and fetching that URL yields a JPEG that really is
  500x750 -- Wikimedia rounds a thumbnail request up to a cached bucket. The
  ratio is preserved, so these two numbers are used for aspect ratio only and
  never as "the size of the image you are about to receive".

* **Thumbnails are served from `thumb.wikimedia.org`** (not
  `upload.wikimedia.org`, which serves the original), with
  `access-control-allow-origin: *`, so a browser can hotlink them. The API
  appends its own `utm_*` query parameters to the URL; they are passed
  through untouched rather than stripped, because that URL is Wikimedia's,
  not ours to rewrite.

* **`extmetadata.Artist` is HTML, not text.** Real values seen:
  `<a rel="nofollow" class="external text" href="...">Bill Abbott</a>` and
  `<a href="//commons.wikimedia.org/wiki/User:Kidfly182" ...>Kidfly182</a>`.
  It is reduced to plain text here and never handed to a browser as markup.

Coverage is landmark-biased, and that is the truth about the data
=================================================================
Measured 2026-09-07 over 60 randomly-sampled real NYC building footprints:
**56 of 60 have no file at all within 40 m.** So the common case for this
feature is the honest fallback, not the photo, and the fallback line is the
feature rather than an apology for it.

The other half of that truth is that a nearby file is not a photo *of* this
building. 360 Smith St, Brooklyn -- an ordinary rowhouse -- returns exactly
one file within 40 m, and it is `Carroll Street Station Mosaic Tile.jpg`, a
subway tile 20.2 m away. Nothing in this API says what a photograph depicts;
coordinates are all there is. So this module never decides that a file "is"
the building, and the caller is given `distance_m` and `title` on every hit
so the card can say where the picture was cataloged and let the reader judge.
Inventing a subject-match heuristic out of a distance threshold would be a
magic number standing in for a fact this project does not have.

A candidate with no readable license is skipped rather than shown
================================================================
`LicenseShortName` (e.g. "CC BY-SA 2.0") is what the attribution line names.
A file that carries neither it nor `UsageTerms` cannot be attributed
correctly, so it is not displayed at all -- and `photo_near()` reports how
many candidates it found alongside how many were usable, so a caller can
tell "Commons has nothing here" from "Commons has something here we could
not attribute". Those are different facts and the card says different words
for them.

User-Agent
==========
Wikimedia's User-Agent policy (https://foundation.wikimedia.org/wiki/Policy:
User-Agent_policy) requires a descriptive agent identifying the application
and a way to reach its operator; anonymous or default-library agents are
throttled or refused. `USER_AGENT` below names the project and links its
public repository, which is the contact route the policy asks for. It carries
no personal contact address on purpose -- the repository is the contact.
"""

import html
import logging
import math
import re

import httpx

logger = logging.getLogger("bearings.sources.commons")

SOURCE = {
    "name": "Wikimedia Commons",
    "url": "https://commons.wikimedia.org/wiki/Commons:Geocoding",
}

API_URL = "https://commons.wikimedia.org/w/api.php"

# Wikimedia asks for an agent that names the tool and a way to reach whoever
# runs it. The repository URL is that route; no email here (see the module
# docstring).
USER_AGENT = "bearings/0.1 (https://github.com/noahejung/bearings) python-httpx"

# The spec's radius. A building footprint's own centroid plus 40 m covers the
# lot and the sidewalk in front of it without reaching across the street.
SEARCH_RADIUS_M = 40

# Three candidates, because the nearest file is not always the usable one --
# a candidate with no readable license is skipped (module docstring), and one
# spare beyond the nearest costs nothing on a single request.
CANDIDATE_LIMIT = 3

# The width asked of Commons' thumbnailer. 480 CSS px is roughly 2x the
# widest the card can render (its own max-width is 200px), so the image is
# still sharp on a 2x display. See the module docstring for why the returned
# `thumbwidth` is not the width of the bytes.
THUMB_WIDTH = 480

# Request-path default. Measured 2026-09-07: 0.67-1.13s per call, with the
# very first call of a cold process (DNS + TLS) once at 1.53s. So 2s is real
# headroom in the normal case and genuinely tight on a cold start -- which is
# the correct place for this to fail, loudly and as "unavailable", rather
# than delaying a click further.
TIMEOUT_S = 2.0

# httpx has no whole-request timeout -- `timeout=2.0` sets connect, read,
# write and pool to 2.0s EACH, so the real worst case of the plain form is
# their sum, not 2s. For a GET with no body against a fresh per-call client
# the only two phases that can consume real time are the connect (DNS + TCP +
# TLS) and the read, so the budget is split across exactly those two and they
# add up to the stated number. Write and pool keep small fixed slices: there
# is no request body to write and no pool to wait on.
#
# THE SPLIT IS MEASURED, AND THE FIRST GUESS AT IT WAS BACKWARDS. An even
# 40/60 connect/read split was written first, on the assumption that a cold
# process pays most of its cost in DNS + TLS. It does not: measured
# 2026-09-07 over three fresh processes, `commons.wikimedia.org` resolves,
# connects and completes a TLS handshake in **0.062-0.109s total**, while the
# API's own response takes 0.6-1.5s. The 1.2s read that split allowed was
# too small, and a live uvicorn's very first landmark click really did come
# back `unavailable (ReadTimeout)` at 1.63s -- caught by driving the running
# server, not by any test. Connect now takes a small fixed slice with ~5x
# headroom over its measured worst case and the read takes everything else.
_CONNECT_SLICE_S = 0.5


def _timeout(budget: float) -> httpx.Timeout:
    connect = min(_CONNECT_SLICE_S, budget / 2)
    return httpx.Timeout(
        connect=connect,
        read=budget - connect,
        write=min(0.5, budget),
        pool=min(0.5, budget),
    )


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
# Commons' own file-page titles are prefixed "File:" in the API; the prefix
# is namespace plumbing, not part of the name a reader should see.
_FILE_PREFIX = "File:"


def _plain_text(value: str | None, *, limit: int = 160) -> str | None:
    """Commons metadata fields are HTML fragments. Reduce one to plain text,
    or `None` if there is nothing left.

    Tags are stripped rather than rendered: this string ends up as an
    element's `textContent` in the browser, and handing user-contributed
    Commons markup to a page as HTML would be an injection surface for a
    caption. Entities are unescaped afterwards so `&amp;` reads as `&`, and
    the result is truncated -- some Commons `Artist` fields are whole
    multi-line institutional credit blocks.
    """
    if not value:
        return None
    text = _WS.sub(" ", html.unescape(_TAG.sub(" ", value))).strip()
    if not text:
        return None
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _meta(extmetadata: dict, key: str) -> str | None:
    entry = extmetadata.get(key)
    if not isinstance(entry, dict):
        return None
    value = entry.get("value")
    return value if isinstance(value, str) else None


def _nearest_distance_m(page: dict) -> float | None:
    """The smallest `dist` across every coordinate this page carries, or
    `None` when the API returned no coordinate for it.

    `None` rather than 0.0 or the search radius: a hit whose distance we
    cannot read is not a hit at zero metres, and the card must be able to
    omit the distance clause instead of printing a number nobody measured.
    """
    distances = [
        c["dist"]
        for c in page.get("coordinates") or []
        if isinstance(c, dict) and isinstance(c.get("dist"), (int, float))
    ]
    if not distances:
        return None
    return round(min(distances), 1)


def _candidate(page: dict) -> dict | None:
    """One geosearch hit turned into the shape the card renders, or `None`
    if it is not a displayable, attributable image."""
    info = page.get("imageinfo") or []
    if not info:
        return None
    info = info[0]

    thumb = info.get("thumburl")
    if not thumb:
        return None

    mime = info.get("mime") or ""
    if not mime.startswith("image/"):
        # A geotagged PDF, video or audio file is a real Commons file and a
        # real neighbour of this building. It is not a photograph of it, and
        # this card has no player.
        return None

    extmetadata = info.get("extmetadata") or {}
    license_name = _plain_text(
        _meta(extmetadata, "LicenseShortName"), limit=40
    ) or _plain_text(_meta(extmetadata, "UsageTerms"), limit=60)
    if not license_name:
        # Cannot be attributed correctly, so it is not shown. See the module
        # docstring.
        return None

    title = page.get("title") or ""
    if title.startswith(_FILE_PREFIX):
        title = title[len(_FILE_PREFIX) :]

    return {
        "title": title,
        "thumb_url": thumb,
        # Aspect ratio only -- these are the requested box, not the served
        # bytes (module docstring).
        "thumb_width": info.get("thumbwidth"),
        "thumb_height": info.get("thumbheight"),
        "description_url": info.get("descriptionurl"),
        "artist": _plain_text(_meta(extmetadata, "Artist")),
        "license": license_name,
        "license_url": _plain_text(_meta(extmetadata, "LicenseUrl"), limit=200),
        "distance_m": _nearest_distance_m(page),
    }


def photo_near(
    lat: float,
    lng: float,
    *,
    radius_m: int = SEARCH_RADIUS_M,
    limit: int = CANDIDATE_LIMIT,
    timeout: float = TIMEOUT_S,
) -> dict:
    """Ask Commons what files it has cataloged within `radius_m` of a point.

    Returns `{"photo": <dict> | None, "candidates": int, "usable": int}`.
    `photo` is `None` -- a real answer, not a failure -- when Commons has
    nothing within the radius, or nothing there that this card can display
    and attribute; `candidates` and `usable` are what let a caller tell those
    two apart in words.

    Raises on a transport or protocol failure (timeout, connection reset,
    non-200, a body that is not the documented shape). The caller turns that
    into the "unavailable" state; it must never collapse into `photo: None`,
    which would tell a reader that Commons has no photo of their building
    when the truth is that nobody asked it successfully.
    """
    params = {
        "action": "query",
        "generator": "geosearch",
        "ggscoord": f"{lat}|{lng}",
        "ggsradius": radius_m,
        # Namespace 6 is File: -- the media namespace.
        "ggsnamespace": 6,
        "ggslimit": limit,
        "prop": "imageinfo|coordinates",
        "iiprop": "url|extmetadata|mime",
        "iiurlwidth": THUMB_WIDTH,
        # See the module docstring: the generator drops `dist`, and only
        # `coprimary=all` reports the coordinate geosearch actually matched.
        "coprimary": "all",
        "colimit": "max",
        "codistancefrompoint": f"{lat}|{lng}",
        "formatversion": 2,
        "format": "json",
    }
    response = httpx.get(
        API_URL,
        params=params,
        headers={"User-Agent": USER_AGENT},
        timeout=_timeout(timeout),
        follow_redirects=True,
    )
    response.raise_for_status()
    body = response.json()

    if "error" in body:
        raise RuntimeError(f"Wikimedia Commons API error: {body['error']}")

    # No files in the radius: the API omits `query` entirely rather than
    # returning an empty list. Confirmed live against a real NYC rowhouse
    # (161 Newel St, Greenpoint) with no cataloged file nearby.
    pages = (body.get("query") or {}).get("pages") or []

    candidates = []
    for page in pages:
        parsed = _candidate(page)
        if parsed is not None:
            candidates.append(parsed)

    # Distance-ordered by us, because the generator's own ordering is not
    # distance (module docstring). A candidate whose distance could not be
    # read sorts last rather than first -- it must not displace one we
    # actually measured.
    candidates.sort(key=lambda c: c["distance_m"] if c["distance_m"] is not None else math.inf)

    return {
        "photo": candidates[0] if candidates else None,
        "candidates": len(pages),
        "usable": len(candidates),
        "radius_m": radius_m,
    }


__all__ = [
    "API_URL",
    "CANDIDATE_LIMIT",
    "SEARCH_RADIUS_M",
    "SOURCE",
    "THUMB_WIDTH",
    "TIMEOUT_S",
    "USER_AGENT",
    "photo_near",
]
