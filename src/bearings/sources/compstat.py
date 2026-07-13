"""NYPD CompStat precinct reports.

nyc.gov 403s a default HTTP client. That is a bot-user-agent block, not
authentication -- the data is public and a browser UA gets a 200.

pdftotext MUST run in -raw mode. -layout scrambles this table's columns and
interleaves rows, which yields numbers that look fine and are wrong."""

import re
import subprocess
from pathlib import Path

import httpx

from bearings import config, staleness

# nyc.gov 403s a default-UA client (see the module docstring), but a real
# browser gets a 200 (confirmed live 2026-07-13) -- this is a landing page
# a user's own click opens with their own browser UA, so the block that
# makes _download() need config.BROWSER_UA doesn't apply here.
SOURCE = {
    "name": "NYPD CompStat",
    "url": "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page",
}

# Column order in a -raw row, after the label:
#   WTD_2026, WTD_2025, WTD_pct, 28D_2026, 28D_2025, 28D_pct,
#   YTD_2026, YTD_2025, YTD_pct, 2yr, 16yr, 33yr
# When a prior-year count is 0, NYPD prints the % change as the literal
# token "***.*" rather than a number -- it still occupies its column, it is
# not omitted. A parser that filters the row down to "tokens that look
# numeric" (dropping "***.*") shifts every later column by one and reads
# the wrong figures into YTD, silently. Verified live against the 1st
# Precinct, whose Fel. Assault row contains exactly this token. So: split
# on whitespace and keep every token in position; only decide per-token
# whether it parses as a number.
_YTD_THIS_IDX = 6
_YTD_PRIOR_IDX = 7
_YTD_PCT_IDX = 8


def _download(pct: int) -> Path:
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.RAW_DIR / f"pct{pct:03d}.pdf"

    if dest.exists():
        staleness.warn_if_stale(
            dest, config.COMPSTAT_CACHE_MAX_AGE_S, f"precinct {pct} CompStat PDF"
        )
        return dest

    resp = httpx.get(
        config.NYPD_PCT_PDF.format(pct=pct),
        headers={"User-Agent": config.BROWSER_UA},
        timeout=60.0,
        follow_redirects=True,
    )
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def _text(pct: int) -> str:
    out = subprocess.run(
        ["pdftotext", "-raw", str(_download(pct)), "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    # Everything after this header is last year's comparison table, not YTD.
    return out.stdout.split("Historical Perspective")[0]


def _num(token: str) -> float | None:
    """Parse one column's token, or None for an undefined '***.*' change."""
    token = token.replace(",", "")
    try:
        return float(token)
    except ValueError:
        return None


def _row_tokens(text: str, label: str) -> list[str]:
    """The whitespace-split tokens after a CompStat row's label, in their
    original column order -- including any literal '***.*' tokens."""
    m = re.search(rf"^{re.escape(label)}\s+(.*)$", text, re.M)
    if not m:
        return []
    return m.group(1).split()


def _ytd(text: str, label: str) -> tuple[int, int, float]:
    """(this year, last year, % change) for a row's YTD columns."""
    tokens = _row_tokens(text, label)
    if len(tokens) <= _YTD_PCT_IDX:
        return (0, 0, 0.0)

    this_year = _num(tokens[_YTD_THIS_IDX])
    last_year = _num(tokens[_YTD_PRIOR_IDX])
    pct = _num(tokens[_YTD_PCT_IDX])

    return (
        int(this_year) if this_year is not None else 0,
        int(last_year) if last_year is not None else 0,
        pct if pct is not None else 0.0,
    )


def fetch_precinct(pct: int) -> dict:
    text = _text(pct)

    week = ""
    m = re.search(r"Through (\d+/\d+/\d+)", text)
    if m:
        week = m.group(1)

    rob = _ytd(text, "Robbery")
    fa = _ytd(text, "Fel. Assault")
    tot = _ytd(text, "TOTAL")

    return {
        "precinct": pct,
        "week_ending": week,
        "robbery_ytd": rob[0],
        "robbery_prior": rob[1],
        "robbery_pct": rob[2],
        "felony_assault_ytd": fa[0],
        "felony_assault_prior": fa[1],
        "felony_assault_pct": fa[2],
        "total_ytd": tot[0],
        "total_pct": tot[2],
    }
