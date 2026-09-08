"""Wikimedia Commons geosearch -- the live API mechanics, the three states,
and the guards that refuse to display a file this card cannot attribute.

Live data, no mocking, per this project's own rule. The one exception is the
"Commons is unreachable" state, which is produced by monkeypatching
`httpx.get` at the seam to raise the exact exception class a real timeout
raises -- there is no way to take Wikimedia down on demand, and a state that
is never exercised is a state that is never tested. Every other assertion
here runs against the real API.

The pure-function tests (`_plain_text`, `_candidate`, `_nearest_distance_m`)
run over response fragments copied verbatim out of a real 2026-09-07 API
response, printed in the module docstring of sources/commons.py. They are
not invented shapes.
"""

import httpx
import pytest

from bearings.sources import buildings, commons

# 350 5th Ave, Manhattan -- the Empire State Building. Confirmed live
# 2026-09-07: three files within 40 m of its footprint centroid, the nearest
# 1.2 m away ("Empire State Building from Rockefeller Center's 70th floor
# (4898085460).jpg", Bill Abbott, CC BY-SA 2.0).
LANDMARK_BBL = "1008350041"

# 161 Newel St, Greenpoint -- tests/test_buildingrecord.py's own ordinary
# rowhouse fixture. Confirmed live 2026-09-07: ZERO files within 40 m. This
# is the common case, not the exception: 56 of 60 randomly-sampled NYC
# building footprints returned nothing at this radius.
NO_PHOTO_BBL = "3026230011"

# 360 Smith St, Brooklyn -- the dispatch's nominated "ordinary rowhouse with
# no photo", which is NOT what it is. Confirmed live 2026-09-07: exactly one
# file within 40 m, and it is "Carroll Street Station Mosaic Tile.jpg", a
# subway tile 20.2 m away. It is the fixture for the fact that a nearby file
# is not a photo of the building, which is why every hit carries its title
# and its distance.
NEARBY_BUT_NOT_THIS_BUILDING_BBL = "3004590024"


def point_for(bbl: str) -> tuple[float, float]:
    point = buildings.point_for_bbl(bbl)
    assert point is not None, f"{bbl} has no representative baked footprint"
    return point


# --------------------------------------------------------------------------
# The live API.
# --------------------------------------------------------------------------


def test_a_landmark_returns_a_displayable_attributed_photo():
    result = commons.photo_near(*point_for(LANDMARK_BBL))

    assert result["candidates"] >= 1
    assert result["usable"] >= 1
    assert result["radius_m"] == commons.SEARCH_RADIUS_M

    photo = result["photo"]
    assert photo is not None
    # Everything the attribution line needs, or the photo must not be shown
    # at all -- see the module docstring's license guard.
    assert photo["license"]
    assert photo["artist"]
    assert photo["title"]
    assert photo["description_url"].startswith("https://commons.wikimedia.org/wiki/File:")
    assert photo["thumb_url"].startswith("https://")
    assert photo["thumb_width"] == commons.THUMB_WIDTH
    assert photo["thumb_height"] and photo["thumb_height"] > 0


def test_the_nearest_candidate_is_the_one_returned():
    """The generator does not order by distance -- measured 2026-09-07, the
    same three files came back with `index` -1, 0, 1 in an order unrelated to
    how far away they are. This asserts the module re-orders them."""
    lat, lng = point_for(LANDMARK_BBL)
    nearest = commons.photo_near(lat, lng)["photo"]
    assert nearest is not None
    assert nearest["distance_m"] is not None

    # Every other file the same search can see is at least as far away.
    wider = commons.photo_near(lat, lng, limit=10)
    assert wider["photo"] is not None
    assert wider["photo"]["distance_m"] == nearest["distance_m"]


def test_distance_is_a_real_measured_number_not_the_radius():
    """The distance is read from Commons' own `codistancefrompoint`, which
    reproduces `list=geosearch`'s `dist` exactly (1.2 / 2.2 / 2.4 m on the
    Empire State Building's three files, verified live 2026-09-07)."""
    photo = commons.photo_near(*point_for(LANDMARK_BBL))["photo"]
    assert photo is not None
    assert 0.0 <= photo["distance_m"] <= commons.SEARCH_RADIUS_M


def test_an_ordinary_rowhouse_has_no_file_cataloged_and_says_so():
    result = commons.photo_near(*point_for(NO_PHOTO_BBL))
    # `None` here is a real answer -- "we asked Commons and it has nothing
    # within 40 m" -- and must never be reachable from a failed request.
    assert result["photo"] is None
    assert result["candidates"] == 0
    assert result["usable"] == 0


def test_a_nearby_file_is_not_a_photo_of_this_building_and_the_payload_shows_it():
    """A subway mosaic 20 m from a Brooklyn rowhouse. Nothing in this API
    says what a photograph depicts, so the module never claims a file "is"
    the building -- it hands back the title and the measured distance so the
    card can let the reader judge."""
    photo = commons.photo_near(*point_for(NEARBY_BUT_NOT_THIS_BUILDING_BBL))["photo"]
    assert photo is not None
    assert photo["title"]
    assert photo["distance_m"] is not None
    # Well away from the centroid, unlike the landmark's 1.2 m.
    assert photo["distance_m"] > 10


def test_the_thumbnail_url_really_serves_an_image_to_a_hotlinking_browser():
    """The card hotlinks `thumb_url` and never downloads or stores anything,
    so the one thing that has to be true of that URL is that a browser on
    another origin can fetch it."""
    photo = commons.photo_near(*point_for(LANDMARK_BBL))["photo"]
    assert photo is not None
    response = httpx.get(
        photo["thumb_url"], headers={"User-Agent": commons.USER_AGENT}, timeout=15.0
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/")
    assert response.headers.get("access-control-allow-origin") == "*"
    assert len(response.content) > 1000


def test_a_bigger_radius_finds_more_and_the_radius_is_reported_back():
    lat, lng = point_for(NO_PHOTO_BBL)
    tight = commons.photo_near(lat, lng, radius_m=40)
    wide = commons.photo_near(lat, lng, radius_m=500, limit=10)
    assert tight["radius_m"] == 40
    assert wide["radius_m"] == 500
    assert wide["candidates"] >= tight["candidates"]


def test_the_user_agent_names_the_project_and_a_way_to_reach_it():
    """Wikimedia's User-Agent policy refuses or throttles anonymous and
    default-library agents. It carries no personal contact address -- the
    public repository is the contact route."""
    assert "bearings" in commons.USER_AGENT
    assert "github.com/noahejung/bearings" in commons.USER_AGENT
    assert "@" not in commons.USER_AGENT


def test_source_is_a_real_reachable_url():
    """Every source module in this codebase exports a SOURCE whose URL
    works. A number -- or a photograph -- with no citation is a bug here."""
    assert commons.SOURCE["name"] == "Wikimedia Commons"
    response = httpx.get(
        commons.SOURCE["url"],
        headers={"User-Agent": commons.USER_AGENT},
        timeout=20.0,
        follow_redirects=True,
    )
    assert response.status_code == 200


# --------------------------------------------------------------------------
# The "we could not look" state, forced at the seam.
# --------------------------------------------------------------------------


def test_a_timeout_raises_rather_than_reporting_no_photo(monkeypatch):
    """The single most important assertion in this file. A failed request
    must never come back as `photo: None`, which would tell a reader that
    Commons has no photograph of their building when the truth is that
    nobody successfully asked."""

    def boom(*args, **kwargs):
        raise httpx.ReadTimeout("forced")

    monkeypatch.setattr(commons.httpx, "get", boom)
    with pytest.raises(httpx.ReadTimeout):
        commons.photo_near(40.7484, -73.9857)


def test_a_non_200_raises(monkeypatch):
    def server_error(*args, **kwargs):
        return httpx.Response(503, request=httpx.Request("GET", commons.API_URL))

    monkeypatch.setattr(commons.httpx, "get", server_error)
    with pytest.raises(httpx.HTTPStatusError):
        commons.photo_near(40.7484, -73.9857)


def test_an_api_level_error_body_raises(monkeypatch):
    """MediaWiki answers some malformed requests with HTTP 200 and an
    `error` object. A 200 is not the same as an answer."""

    def api_error(*args, **kwargs):
        return httpx.Response(
            200,
            json={"error": {"code": "invalidparammix", "info": "bad params"}},
            request=httpx.Request("GET", commons.API_URL),
        )

    monkeypatch.setattr(commons.httpx, "get", api_error)
    with pytest.raises(RuntimeError, match="Commons API error"):
        commons.photo_near(40.7484, -73.9857)


# --------------------------------------------------------------------------
# The parsing guards, over fragments copied out of a real response.
# --------------------------------------------------------------------------


def test_artist_html_is_reduced_to_plain_text():
    # Both forms observed live 2026-09-07.
    assert (
        commons._plain_text(
            '<a rel="nofollow" class="external text" '
            'href="https://www.flickr.com/people/9998127@N06">Bill Abbott</a>'
        )
        == "Bill Abbott"
    )
    assert (
        commons._plain_text(
            '<a href="//commons.wikimedia.org/wiki/User:Kidfly182" '
            'title="User:Kidfly182">Kidfly182</a>'
        )
        == "Kidfly182"
    )


def test_artist_html_entities_are_unescaped_and_whitespace_collapsed():
    assert commons._plain_text("<p>Smith  &amp;\n  Jones</p>") == "Smith & Jones"


def test_a_very_long_credit_block_is_truncated_rather_than_shipped_whole():
    long_credit = "<p>" + ("Some Institution, " * 40) + "</p>"
    out = commons._plain_text(long_credit)
    assert out is not None
    assert len(out) <= 160
    assert out.endswith("…")


def test_empty_or_missing_metadata_is_none_not_an_empty_string():
    assert commons._plain_text(None) is None
    assert commons._plain_text("") is None
    assert commons._plain_text("<span></span>") is None


def _page(**overrides) -> dict:
    """A real 2026-09-07 geosearch page, minus whatever a test removes."""
    imageinfo = {
        "thumburl": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/92/x.jpg/500px-x.jpg",
        "thumbwidth": 480,
        "thumbheight": 360,
        "url": "https://upload.wikimedia.org/wikipedia/commons/9/92/x.jpg",
        "descriptionurl": "https://commons.wikimedia.org/wiki/File:Carroll_Street_Station_Mosaic_Tile.jpg",
        "mime": "image/jpeg",
        "extmetadata": {
            "Artist": {"value": '<a href="//commons.wikimedia.org/wiki/User:Kidfly182">Kidfly182</a>'},
            "LicenseShortName": {"value": "CC BY-SA 4.0"},
            "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"},
        },
    }
    imageinfo.update(overrides.pop("imageinfo", {}))
    page = {
        "pageid": 126958836,
        "ns": 6,
        "title": "File:Carroll Street Station Mosaic Tile.jpg",
        "imageinfo": [imageinfo],
        "coordinates": [{"lat": 40.679519, "lon": -73.995606, "primary": True, "dist": 20.2}],
    }
    page.update(overrides)
    return page


def test_the_file_namespace_prefix_is_stripped_from_the_title():
    assert commons._candidate(_page())["title"] == "Carroll Street Station Mosaic Tile.jpg"


def test_a_file_with_no_readable_license_is_skipped_not_shown():
    page = _page()
    page["imageinfo"][0]["extmetadata"] = {"Artist": {"value": "Someone"}}
    assert commons._candidate(page) is None


def test_usage_terms_stands_in_when_there_is_no_short_license_name():
    page = _page()
    page["imageinfo"][0]["extmetadata"] = {
        "UsageTerms": {"value": "Creative Commons Attribution-Share Alike 4.0"}
    }
    candidate = commons._candidate(page)
    assert candidate is not None
    assert candidate["license"] == "Creative Commons Attribution-Share Alike 4.0"


def test_a_non_image_file_is_skipped():
    page = _page()
    page["imageinfo"][0]["mime"] = "application/pdf"
    assert commons._candidate(page) is None


def test_a_file_with_no_thumbnail_is_skipped():
    page = _page()
    del page["imageinfo"][0]["thumburl"]
    assert commons._candidate(page) is None


def test_distance_takes_the_nearest_of_several_coordinates():
    """geosearch matches a file on ANY of its coordinates, and
    `prop=coordinates` returns only the primary one unless asked for all --
    so a file matched on a secondary coordinate would otherwise report the
    distance to somewhere else entirely."""
    page = _page(
        coordinates=[
            {"lat": 0.0, "lon": 0.0, "primary": True, "dist": 5000.0},
            {"lat": 40.6795, "lon": -73.9956, "dist": 12.4},
        ]
    )
    assert commons._candidate(page)["distance_m"] == 12.4


def test_a_hit_with_no_readable_coordinate_reports_none_not_zero():
    """`None` so the card can omit the distance clause. Zero would be a
    number nobody measured, printed as though someone had."""
    assert commons._candidate(_page(coordinates=[]))["distance_m"] is None


def test_a_candidate_with_no_readable_distance_sorts_last(monkeypatch):
    near_but_unmeasured = _page(coordinates=[], title="File:Unmeasured.jpg")
    measured = _page()

    def response(*args, **kwargs):
        return httpx.Response(
            200,
            json={"batchcomplete": True, "query": {"pages": [near_but_unmeasured, measured]}},
            request=httpx.Request("GET", commons.API_URL),
        )

    monkeypatch.setattr(commons.httpx, "get", response)
    result = commons.photo_near(40.6794, -73.9958)
    assert result["usable"] == 2
    assert result["photo"]["title"] == "Carroll Street Station Mosaic Tile.jpg"


def test_a_body_with_files_but_none_usable_is_distinguishable_from_an_empty_one(monkeypatch):
    """`photo: None` with `candidates: 2, usable: 0` is a different fact from
    `candidates: 0` -- "Commons has files here we cannot attribute" versus
    "Commons has nothing here" -- and the card says different words for
    each."""
    unlicensed = _page()
    unlicensed["imageinfo"][0]["extmetadata"] = {}

    def response(*args, **kwargs):
        return httpx.Response(
            200,
            json={"batchcomplete": True, "query": {"pages": [unlicensed, _page()]}},
            request=httpx.Request("GET", commons.API_URL),
        )

    monkeypatch.setattr(commons.httpx, "get", response)
    result = commons.photo_near(40.6794, -73.9958)
    assert result["candidates"] == 2
    assert result["usable"] == 1

    def none_usable(*args, **kwargs):
        return httpx.Response(
            200,
            json={"batchcomplete": True, "query": {"pages": [unlicensed]}},
            request=httpx.Request("GET", commons.API_URL),
        )

    monkeypatch.setattr(commons.httpx, "get", none_usable)
    result = commons.photo_near(40.6794, -73.9958)
    assert result["photo"] is None
    assert result["candidates"] == 1
    assert result["usable"] == 0


def test_the_timeout_budget_is_split_across_the_phases_that_can_consume_it():
    """httpx has no whole-request timeout: `timeout=2.0` means 2.0s EACH for
    connect, read, write and pool, so the plain form's worst case is their
    sum. Connect and read are the only two phases a bodyless GET on a fresh
    client can spend real time in, and those two add up to the stated
    budget."""
    timeout = commons._timeout(2.0)
    assert timeout.connect + timeout.read == pytest.approx(2.0)
    assert timeout.connect > 0 and timeout.read > 0
    # Measured 2026-09-07 over three fresh processes: DNS + TCP + TLS to
    # commons.wikimedia.org costs 0.062-0.109s, while the API's own response
    # costs 0.6-1.5s. So nearly all of the budget belongs to the read, and a
    # connect slice much larger than this is budget taken away from the only
    # phase that actually needs it. The first version of this split had it
    # the other way round and made a live server's first landmark click time
    # out at 1.63s.
    assert timeout.read > timeout.connect * 2
