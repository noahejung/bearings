from bearings.sources import neighborhoods


def test_returns_every_real_nta_citywide():
    rows = neighborhoods.labels()
    # 262 features confirmed live 2026-07-15 -- guard against a truncated
    # page (Socrata's default $limit is 1000, but a regression that dropped
    # the explicit override would silently cap at Socrata's older 100-row
    # default instead).
    assert len(rows) > 200
    names = {r["name"] for r in rows}
    assert "Greenpoint" in names
    assert "Park Slope" in names or "Prospect Park" in names


def test_every_row_has_a_real_coordinate_and_borough():
    for r in neighborhoods.labels():
        assert 40.4 < r["lat"] < 41.0
        assert -74.4 < r["lng"] < -73.6
        assert r["borough"] in {
            "Manhattan",
            "Brooklyn",
            "Queens",
            "Bronx",
            "Staten Island",
        }
        assert r["name"]
        assert r["nta2020"]


def test_sources_cites_a_real_working_url():
    assert neighborhoods.SOURCE["name"]
    assert neighborhoods.SOURCE["url"].startswith("http")
