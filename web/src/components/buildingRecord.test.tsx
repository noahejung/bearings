// SPEC-building-card-v2.md Part A: "a frontend test that the card renders
// loading -> values -> the three states."
//
// The payloads below are the real shapes GET /api/building/{bbl} returns,
// copied from live responses recorded 2026-09-07 (1 Wall St 1000470001, 60 W
// 36 St 1008370078, 346 E 4 St 1003730026, and the '3999999999' placeholder
// BBL whose footprints are too scattered to name a point for). They are
// fixtures for a pure rendering function, not stand-ins for a live call --
// the endpoint itself is tested against live data in tests/test_api.py and
// tests/test_buildingrecord.py.

import { describe, expect, it } from "vitest";
import {
  buildRecordBlock,
  recordRows,
  recordSourceLines,
  type RecordState,
} from "./buildingRecord";
import type { BuildingRecord } from "../types";

const SOURCES: BuildingRecord["sources"] = {
  bedbugs: {
    name: "NYC Bedbug Filings",
    url: "https://data.cityofnewyork.us/d/wz6d-d3jb",
    as_of: "2026-09-07",
    baked: true,
  },
  rodents: {
    name: "NYC DOHMH Rodent Inspections",
    url: "https://data.cityofnewyork.us/d/p937-wjvj",
    as_of: "2026-09-07",
    baked: false,
  },
  heat: {
    name: "NYC 311",
    url: "https://data.cityofnewyork.us/d/erm2-nwe9",
    as_of: "2026-09-07",
    baked: true,
  },
  flood: {
    name: "FEMA National Flood Hazard Layer",
    url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    as_of: "2026-09-07",
    baked: false,
  },
  pavement: {
    name: "NYC DOT Street Pavement Ratings",
    url: "https://data.cityofnewyork.us/d/6yyb-pb25",
    as_of: "2026-09-07",
    baked: false,
  },
};

const HEAT_CAVEAT =
  "311 could not attach a bbl to about 0.35% of this season's heat complaints, so a building's count can be short by its own share of those -- 311's geocoding gap, not a gap this project can close.";

// Every field in its VALUE state. 60 W 36 St's real bedbug numbers, 346 E 4
// St's real rodent numbers, Red Hook's real Zone AE, 1 Wall St's real DOT
// rating.
const ALL_VALUES: BuildingRecord = {
  bbl: "1008370078",
  point: { lat: 40.75048, lng: -73.98607 },
  bedbugs: {
    filings: 6,
    period_end: "2025-10-31",
    units_total: 135,
    units_infested: 9,
    units_reinfested: 2,
    units_eradicated: 0,
  },
  rodents: {
    inspections: 4,
    failed: 3,
    last_result: "Failed for Rat Activity",
    last_date: "2026-06-06",
    months: 24,
  },
  heat: {
    complaints: 9,
    seasons: 1,
    season_start: "2025-10-01",
    season_end: "2026-06-01",
    caveat: HEAT_CAVEAT,
  },
  flood: {
    zone: "AE",
    description:
      "Special Flood Hazard Area: 1% annual chance flood (the base/100-year flood), with Base Flood Elevation determined.",
    in_special_flood_hazard_area: true,
    base_flood_elevation_ft: 10.0,
  },
  pavement: {
    segments_rated: 25,
    average_rating: 7.65,
    good: 13,
    fair: 11,
    poor: 1,
    most_recent_inspection: "2026-04-11",
  },
  sources: SOURCES,
};

// Every nullable field in its NO-RECORD state.
const ALL_EMPTY: BuildingRecord = {
  ...ALL_VALUES,
  bbl: "2046990051",
  bedbugs: null,
  rodents: null,
  heat: { ...ALL_VALUES.heat, complaints: 0 },
  flood: null,
  pavement: null,
};

// Every live field in its UNAVAILABLE state -- the real reason strings the
// endpoint emits.
const ALL_UNAVAILABLE: BuildingRecord = {
  ...ALL_VALUES,
  bbl: "3999999999",
  rodents: {
    unavailable: true,
    reason:
      "NYC DOHMH Rodent Inspections did not answer within 3.5s. This is not a record of 'no problems found' -- the source was not reachable in time.",
  },
  flood: {
    unavailable: true,
    reason:
      "no single baked building footprint represents this BBL, so there is no point to look up",
  },
  pavement: {
    unavailable: true,
    reason:
      "no single baked building footprint represents this BBL, so there is no point to look up",
  },
};

function tones(state: RecordState): Record<string, string> {
  return Object.fromEntries(recordRows(state).map((r) => [r.key, r.tone]));
}

function values(state: RecordState): Record<string, string> {
  return Object.fromEntries(recordRows(state).map((r) => [r.key, r.value]));
}

describe("building record rows", () => {
  it("shows all five rows in a loading state before the record arrives", () => {
    const rows = recordRows({ status: "loading" });
    expect(rows.map((r) => r.key)).toEqual([
      "bedbugs",
      "rodents",
      "heat",
      "flood",
      "pavement",
    ]);
    expect(rows.every((r) => r.tone === "loading")).toBe(true);
  });

  it("renders real values once the record lands", () => {
    const state: RecordState = { status: "ready", record: ALL_VALUES };
    expect(values(state)).toEqual({
      bedbugs: "9 of 135 units",
      rodents: "3 of 4 failed",
      heat: "9 311 complaints",
      flood: "Zone AE, high risk",
      pavement: "7.7 of 10",
    });
    // Adverse findings are flagged; nothing here is "empty" or
    // "unavailable".
    expect(tones(state)).toEqual({
      bedbugs: "flag",
      rodents: "flag",
      heat: "flag",
      flood: "flag",
      pavement: "value",
    });
  });

  it("says 'no record' in words a reader cannot mistake for a clean result", () => {
    const state: RecordState = { status: "ready", record: ALL_EMPTY };
    expect(values(state)).toEqual({
      bedbugs: "no filing on record",
      rodents: "not inspected in 24 months",
      heat: "no complaints",
      flood: "no FEMA study here",
      pavement: "no rated street nearby",
    });
    // Heat is the exception on purpose: the bake counts the whole city for
    // the whole season, so zero here is a measured zero, not a missing
    // value -- and it must read as a real finding, not as an absence.
    expect(tones(state).heat).toBe("value");
    expect(tones(state).bedbugs).toBe("empty");
  });

  it("never renders 'unavailable' with the same words as 'no record'", () => {
    const down = { status: "ready", record: ALL_UNAVAILABLE } as const;
    const empty = { status: "ready", record: ALL_EMPTY } as const;
    for (const key of ["rodents", "flood", "pavement"]) {
      expect(values(down)[key]).not.toBe(values(empty)[key]);
      expect(tones(down)[key]).toBe("unavailable");
      expect(tones(empty)[key]).toBe("empty");
    }
    // ...and never as an adverse finding either: a source being down is not
    // bad news about the building. (The two BAKED fields in this fixture do
    // still flag -- they answered. That is the mixed case the endpoint
    // actually produces, and it is the point of running the live sources in
    // parallel: a source that is down must not blank out the ones that
    // aren't.)
    for (const key of ["rodents", "flood", "pavement"]) {
      expect(tones(down)[key]).not.toBe("flag");
    }
    expect(tones(down).bedbugs).toBe("flag");
    expect(tones(down).heat).toBe("flag");
  });

  it("carries the reason behind every unavailable row", () => {
    const rows = recordRows({ status: "ready", record: ALL_UNAVAILABLE });
    const unavailable = rows.filter((r) => r.tone === "unavailable");
    expect(unavailable.map((r) => r.key)).toEqual(["rodents", "flood", "pavement"]);
    for (const row of unavailable) {
      // The reason is the whole difference between "unavailable" and a
      // shrug. It is rendered as `title`, so the short row never has to
      // carry the sentence.
      expect(row.detail).toBeTruthy();
      expect(row.detail!.length).toBeGreaterThan(20);
    }
    // The two real reasons the endpoint emits, distinguishable from each
    // other: a timed-out source, and a BBL with no single representative
    // point.
    expect(unavailable[0].detail).toContain("not reachable in time");
    expect(unavailable[1].detail).toContain("point");
  });

  it("turns a failed fetch into five unavailable rows, not five empty ones", () => {
    const state: RecordState = { status: "error", message: "HTTP 502" };
    expect(new Set(recordRows(state).map((r) => r.tone))).toEqual(
      new Set(["unavailable"]),
    );
    expect(recordRows(state).every((r) => r.detail === "HTTP 502")).toBe(true);
  });

  it("splits the sources line by vintage so baked and live are not implied equal", () => {
    const lines = recordSourceLines({ status: "ready", record: ALL_VALUES });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("NYC Bedbug Filings");
    expect(lines[0]).toContain("NYC 311");
    expect(lines[0]).toContain("baked 2026-09-07");
    expect(lines[1]).toContain("FEMA National Flood Hazard Layer");
    expect(lines[1]).toContain("live 2026-09-07");
  });

  it("cites nothing while loading -- a citation for numbers that never arrived would be wrong", () => {
    expect(recordSourceLines({ status: "loading" })).toEqual([]);
    expect(recordSourceLines({ status: "error", message: "x" })).toEqual([]);
  });
});

describe("building record block DOM", () => {
  it("transitions loading -> values in place, without rebuilding the element", () => {
    const block = buildRecordBlock();
    const grid = block.el.querySelector(".buildinginfo__record-grid");
    expect(grid).not.toBeNull();
    expect(block.el.querySelectorAll("dd[data-state='loading']")).toHaveLength(5);
    expect(block.el.querySelectorAll(".buildinginfo__source")).toHaveLength(0);

    block.update({ status: "ready", record: ALL_VALUES });

    // Same grid node, refilled -- the marker never re-anchors.
    expect(block.el.querySelector(".buildinginfo__record-grid")).toBe(grid);
    expect(block.el.querySelectorAll("dd[data-state='loading']")).toHaveLength(0);
    expect(block.el.querySelectorAll("dd")).toHaveLength(5);
    expect(block.el.querySelectorAll(".buildinginfo__source")).toHaveLength(2);
  });

  it("marks each row's state on the element so the three are distinguishable in the DOM", () => {
    const block = buildRecordBlock({ status: "ready", record: ALL_UNAVAILABLE });
    const rodents = block.el.querySelector<HTMLElement>("dd[data-row='rodents']");
    expect(rodents?.dataset.state).toBe("unavailable");
    expect(rodents?.className).toContain("buildinginfo__record-value--unavailable");
    expect(rodents?.title).toContain("not a record of");

    const bedbugs = block.el.querySelector<HTMLElement>("dd[data-row='bedbugs']");
    expect(bedbugs?.dataset.state).toBe("flag");
    expect(bedbugs?.className).not.toContain("--unavailable");
  });

  it("renders a heading so the block is not five unlabelled numbers", () => {
    const block = buildRecordBlock();
    expect(block.el.querySelector(".buildinginfo__record-heading")?.textContent).toBe(
      "Building record",
    );
  });
});
