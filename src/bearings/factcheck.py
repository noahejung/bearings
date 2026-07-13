"""Fact-check listing marketing language against the real neighbourhood data.

Rule-based claim extraction, not an LLM: a curated list of real-estate
marketing phrases is matched against the listing text with regex.
Deterministic, no API key, no hallucination -- every phrase maps to a
predicate this module can actually check against profile.profile_for().
See SPEC.md's "the fact-checker" section and PLAN.md's fact-checker task.

THE ONE RULE THAT GOVERNS THIS FILE: report the data, never render a
verdict. `evidence` is always a factual sentence, with a number in it
wherever a number exists. It never contains "misleading", "a scam",
"lying", or any characterisation of the landlord or the listing --
`status` is a data-driven classification (does the number agree with the
claim or not), not an editorial one. Truth is an absolute defense; the
count is more damning than any adjective, and it's the only thing that
survives a defamation claim on contact.
"""

import re

from bearings import profile

# ---------------------------------------------------------------------------
# Thresholds. Every one of these is a judgement call; the reasoning for each
# is documented next to it. None of them is scientifically precise -- they
# exist so a claim classifies consistently, not because e.g. "50 complaints"
# is a natural law separating quiet from loud.
#
# The API's `status` enum (see the contract) has exactly four values and
# none of them means "ambiguous" -- there is no fifth "inconclusive" status
# to fall back on for values that land between "clearly true" and "clearly
# false." So every threshold pair below defines two *confident* bounds
# (at/below the low bound is confidently one status, at/above the high
# bound is confidently the other), and `_status_for()` resolves the gap
# between them deterministically, by which side of the midpoint the value
# falls on. That keeps the arbitrariness of the boundary visible in one
# place (the midpoint formula) instead of hiding it behind a single
# unexplained cutoff picked by feel.
# ---------------------------------------------------------------------------

# "quiet" / "peaceful" / "serene" / "tranquil" vs. 311 noise complaints in
# the trailing 12 months, within 400m (roughly a 5-minute walk at
# transit.WALK_SPEED_MPS).
#
# These two numbers were originally picked by feel (<=15 / >=50) and were
# off by roughly an order of magnitude: a live sweep of complaints_near()
# across ~20 real NYC points -- genuinely quiet outer-borough residential
# streets (Riverdale 11, Fieldston 13, Great Kills 31, Douglaston 44, Kew
# Gardens 238) through brownstone-quiet blocks with some nearby commercial
# exposure (Bay Ridge 442, Ditmas Park 495, Carroll Gardens 581, Prospect
# Park South 642) up to genuinely loud commercial/nightlife corridors
# (Herald Sq 899, Empire State 1,297, Union Sq 1,714, Bushwick/St Marks/LES
# nightlife 2,500-4,700) -- showed the old bounds landed almost every
# ordinary residential address on the "contradicted" side, including the
# app's own "quiet, far, green" Riverdale demo address (318 complaints,
# previously misclassified). Recalibrated against that distribution: the
# quiet bound covers genuinely low-traffic residential streets, the loud
# bound sits just under Midtown-grade addresses, and the wide gap between
# them is deliberate -- 400m is not a small radius, and a fixed-radius
# complaint count is an inherently noisy (no pun intended) proxy for
# subjective "quiet." See README's Known Simplifications.
NOISE_QUIET_AT_OR_BELOW = 250
NOISE_LOUD_AT_OR_ABOVE = 1200

# "tree-lined" / "leafy" / "verdant" vs. living Street Tree Census trees in
# the same 400m radius. NYC's post-MillionTreesNYC canopy is denser than
# intuition suggests -- even a dense commercial Midtown corner carries
# ~280 trees in that radius (confirmed live, see tests/test_trees.py) -- so
# the bar for "genuinely leafy" has to sit well above zero, and "clearly
# not tree-lined" has to be low enough to catch blocks with almost no
# street trees at all (highway frontage, industrial waterfront, etc).
TREES_SPARSE_AT_OR_BELOW = 15
TREES_LEAFY_AT_OR_ABOVE = 100

# "steps from the subway" / "moments from the train" / "close to transit"
# vs. walk_minutes to the nearest station. Real-estate copy means "steps"
# close to literally; five minutes is already generous. Past ~12 minutes
# there is no honest reading of "steps."
TRANSIT_STEPS_AT_OR_BELOW_MIN = 5
TRANSIT_NOT_CLOSE_AT_OR_ABOVE_MIN = 12

# "well-maintained" / "well-kept" / "pristine building" / "impeccably
# maintained" vs. open Class C HPD violations. Unlike noise (a fuzzy
# nuisance signal with real week-to-week variance), Class C is a legal
# determination the city has already made -- the condition is "immediately
# hazardous." There is no defensible ambiguous middle for that: zero open
# Class C violations supports the claim, one or more contradicts it
# outright. No _status_for() call here; this predicate really is binary.
VIOLATIONS_CLASS_C_TOLERANCE = 0

# "close to everything" / "steps from it all" / "in the heart of" vs. total
# POI count (all amenity buckets combined) in the address's cell + its
# 1-ring neighbours (~10-minute walk). Calibrated against the same
# addresses profile.py's own tests use: Midtown clears dozens of POIs,
# residential side streets clear a handful.
AMENITIES_SPARSE_AT_OR_BELOW = 8
AMENITIES_DENSE_AT_OR_ABOVE = 40


def _status_for(
    value: float,
    low_bound: float,
    high_bound: float,
    low_status: str,
    high_status: str,
) -> str:
    """`low_status` at/below `low_bound`, `high_status` at/above
    `high_bound`. Between the two, resolve deterministically to whichever
    side of the midpoint `value` falls on -- see the threshold block above
    for why a genuine third "ambiguous" status isn't available here.
    """
    if value <= low_bound:
        return low_status
    if value >= high_bound:
        return high_status
    midpoint = (low_bound + high_bound) / 2
    return high_status if value >= midpoint else low_status


# ---------------------------------------------------------------------------
# Sources. Every claim carries one of these -- a claim without a source is a
# bug (see the API contract's non-negotiables). The two predicates we can't
# check yet (renovation, sunlight) still cite a real, verified URL: the
# dataset (or general portal) a future ingest would draw from, never a
# placeholder. Verified live 2026-07-13.
# ---------------------------------------------------------------------------

_TRANSIT_SOURCE = {
    "name": "MTA GTFS + PATH GTFS",
    "url": "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
}
_AMENITIES_SOURCE = {
    "name": "Overture Maps Places",
    "url": "https://docs.overturemaps.org/guides/places/",
}
# DOB permits are not ingested yet (see the fact-checker task's predicate
# table), but the dataset that would check "newly renovated" is real and
# live -- cite it now so the source is honest about what *would* answer
# this, not a placeholder.
_RENOVATION_SOURCE = {
    "name": "NYC DOB Permit Issuance (not yet ingested)",
    "url": "https://data.cityofnewyork.us/Housing-Development/DOB-Permit-Issuance/ipu4-2q9a",
}
# Sunlight would need building footprints + heights + solar geometry, not
# one single dataset -- cite the general portal rather than guessing at a
# specific 4x4 dataset ID we have not verified.
_SUNLIGHT_SOURCE = {
    "name": "NYC Open Data (building footprints + solar modelling not yet built)",
    "url": "https://opendata.cityofnewyork.us/",
}
_UNFALSIFIABLE_SOURCE = {
    "name": "Puffery (marketing & advertising law)",
    "url": "https://en.wikipedia.org/wiki/Puffery",
}

_ClaimEval = tuple[str, str, "int | None", dict]


def _check_noise(prof: dict) -> _ClaimEval:
    count = prof["quiet"]["noise_complaints_12mo"]
    status = _status_for(
        count, NOISE_QUIET_AT_OR_BELOW, NOISE_LOUD_AT_OR_ABOVE, "supported", "contradicted"
    )
    evidence = f"{count} 311 noise complaints within a 5-minute walk in the last 12 months."
    return status, evidence, count, dict(prof["quiet"]["source"])


def _check_trees(prof: dict) -> _ClaimEval:
    count = prof["green"]["street_trees_nearby"]
    status = _status_for(
        count, TREES_SPARSE_AT_OR_BELOW, TREES_LEAFY_AT_OR_ABOVE, "contradicted", "supported"
    )
    evidence = f"{count} living street trees within a 5-minute walk."
    return status, evidence, count, dict(prof["green"]["source"])


def _check_transit_walk(prof: dict) -> _ClaimEval:
    nearby = prof["transit"]["nearest_stations"]
    if not nearby:
        # profile.STATION_SEARCH_M -- no station was found within that
        # radius at all. That absence is itself real evidence against
        # "steps from the subway," not a reason to call this no_data.
        evidence = "No subway or PATH station within 1,200 metres of this address."
        return "contradicted", evidence, None, dict(_TRANSIT_SOURCE)

    nearest = nearby[0]
    minutes = nearest["walk_minutes"]
    status = _status_for(
        minutes,
        TRANSIT_STEPS_AT_OR_BELOW_MIN,
        TRANSIT_NOT_CLOSE_AT_OR_ABOVE_MIN,
        "supported",
        "contradicted",
    )
    evidence = f"{nearest['name']} is a {minutes}-minute walk from this address."
    return status, evidence, minutes, dict(_TRANSIT_SOURCE)


def _check_violations(prof: dict) -> _ClaimEval:
    bbl = prof["location"]["bbl"]
    source = dict(prof["building"]["source"])

    if bbl is None:
        evidence = "No BBL on record for this address, so building violation history cannot be checked."
        return "no_data", evidence, None, source

    class_c = prof["building"]["hpd_open_violations"]["class_c"]
    status = "contradicted" if class_c > VIOLATIONS_CLASS_C_TOLERANCE else "supported"
    noun = "violation" if class_c == 1 else "violations"
    evidence = f"{class_c} open Class C (immediately hazardous) HPD {noun} on record for this building."
    return status, evidence, class_c, source


def _check_renovation(prof: dict) -> _ClaimEval:
    evidence = "DOB permit filings are not yet ingested -- cannot confirm or refute a renovation claim."
    return "no_data", evidence, None, dict(_RENOVATION_SOURCE)


def _check_sunlight(prof: dict) -> _ClaimEval:
    evidence = (
        "Solar/shadow modelling from building footprints and heights is not "
        "yet built -- cannot confirm or refute a sunlight claim."
    )
    return "no_data", evidence, None, dict(_SUNLIGHT_SOURCE)


def _check_amenities(prof: dict) -> _ClaimEval:
    total = sum(prof["amenities"].values())
    status = _status_for(
        total, AMENITIES_SPARSE_AT_OR_BELOW, AMENITIES_DENSE_AT_OR_ABOVE, "contradicted", "supported"
    )
    evidence = f"{total} points of interest within a ~10-minute walk of this address."
    return status, evidence, total, dict(_AMENITIES_SOURCE)


def _check_unfalsifiable(prof: dict) -> _ClaimEval:
    evidence = "This is a marketing phrase, not a checkable factual claim -- no dataset can confirm or refute it."
    return "unfalsifiable", evidence, None, dict(_UNFALSIFIABLE_SOURCE)


_PREDICATE_CHECKS = {
    "noise": _check_noise,
    "trees": _check_trees,
    "transit_walk": _check_transit_walk,
    "violations": _check_violations,
    "renovation": _check_renovation,
    "sunlight": _check_sunlight,
    "amenities": _check_amenities,
    "unfalsifiable": _check_unfalsifiable,
}

# ---------------------------------------------------------------------------
# Claim extraction. Rule-based, not an LLM: a curated list of real-estate
# marketing phrases, matched with regex against the listing text. Each
# phrase maps to one of the predicates checked above.
# ---------------------------------------------------------------------------

_PHRASES: list[tuple[str, str]] = [
    # (phrase, predicate)
    ("quiet", "noise"),
    ("peaceful", "noise"),
    ("serene", "noise"),
    ("tranquil", "noise"),
    ("tree-lined", "trees"),
    ("leafy", "trees"),
    ("verdant", "trees"),
    ("steps from the subway", "transit_walk"),
    ("moments from the train", "transit_walk"),
    ("close to transit", "transit_walk"),
    ("well-maintained", "violations"),
    ("well-kept", "violations"),
    ("pristine building", "violations"),
    ("impeccably maintained", "violations"),
    ("newly renovated", "renovation"),
    ("gut renovated", "renovation"),
    ("recently updated", "renovation"),
    ("sun-drenched", "sunlight"),
    ("sun-filled", "sunlight"),
    ("bright", "sunlight"),
    ("flooded with light", "sunlight"),
    ("close to everything", "amenities"),
    ("steps from it all", "amenities"),
    ("in the heart of", "amenities"),
    ("prime location", "unfalsifiable"),
    ("charming", "unfalsifiable"),
    ("must-see", "unfalsifiable"),
    ("won't last", "unfalsifiable"),
    ("a true gem", "unfalsifiable"),
]

_PATTERNS = [
    (re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE), predicate)
    for phrase, predicate in _PHRASES
]

# Clause boundaries for extracting a tight, on-topic `quote` per claim.
# Splitting on commas as well as sentence terminators keeps two unrelated
# claims packed into one marketing sentence ("quiet, tree-lined street,
# steps from the subway") from sharing one sprawling quote -- each claim
# gets just the fragment that actually triggered it.
_CLAUSE_SPLIT = re.compile(r"[.!?;\n]+|,\s*")


def _clauses(listing_text: str) -> list[str]:
    return [c.strip() for c in _CLAUSE_SPLIT.split(listing_text) if c.strip()]


def _extract_claims(listing_text: str, prof: dict) -> list[dict]:
    claims: list[dict] = []
    seen: set[tuple[int, str]] = set()  # (clause index, predicate) -- de-dupe
    # synonyms of the same predicate landing in the same clause, e.g.
    # "quiet and peaceful" matching both "quiet" and "peaceful".

    for idx, clause in enumerate(_clauses(listing_text)):
        for pattern, predicate in _PATTERNS:
            if (idx, predicate) in seen or not pattern.search(clause):
                continue
            seen.add((idx, predicate))

            status, evidence, value, source = _PREDICATE_CHECKS[predicate](prof)
            claims.append(
                {
                    "quote": clause,
                    "predicate": predicate,
                    "status": status,
                    "evidence": evidence,
                    "value": value,
                    "source": source,
                }
            )

    return claims


def check(address: str, listing_text: str) -> dict:
    """Extract marketing claims from `listing_text` and check each one
    against the real neighbourhood data for `address`.

    Returns the /api/factcheck response shape exactly -- see the API
    contract in the fact-checker task prompt / PLAN.md.
    """
    prof = profile.profile_for(address)
    return {
        "address": prof["address"],
        "claims": _extract_claims(listing_text, prof),
    }
