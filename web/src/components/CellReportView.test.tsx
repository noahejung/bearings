import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CellReportView, GettingAroundField } from "./CellReportView";
import type { CellProfile } from "../types";

// Real shapes, live-captured 2026-07-18 from `bearings.cellprofile.
// profile_for()` against the real, currently-baked shard data -- per this
// repo's own "no mocking" discipline (App.test.tsx's own comment states the
// same convention for its fixtures). These are the exact three cells named
// in this project's 2026-07-18 "no-route" diagnosis/fix/copy-split reports:
// a real Staten Island Railway (no rail connection) cell, a real transit-
// desert (no station in range) cell nearby, and the Grand Central control.

const TRANSIT_SOURCE = {
  name: "MTA GTFS + PATH GTFS",
  url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
};
const CAVEAT =
  "In-vehicle time plus a nominal transfer penalty. Excludes the walk from your door and the wait on the platform. Treat as a floor, not a door-to-door estimate.";

const AMENITIES_SOURCE = { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" };
const NOISE_SOURCE = { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" };
const TREES_SOURCE = { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" };
const PLUTO_SOURCE = { name: "NYC PLUTO", url: "https://data.cityofnewyork.us/d/64uk-42ks" };
const CRIME_SOURCE = {
  name: "NYPD CompStat",
  url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page",
};
const HAZARD_SOURCE = { name: "NYC HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" };
const CRIME_CAVEAT =
  "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate; NYC Open Data publishes no population figure per precinct. Reported counts reflect policing and reporting intensity as well as public safety, and precinct boundaries are coarse.";
const HAZARD_NOTE =
  "Open Class C (\"immediately hazardous\") HPD violations only, summed across every tax lot centred in this cell -- a violation is entered only after an HPD inspection confirms a real code violation, which is a step up from a raw, unverified complaint. Still reflects inspection and reporting intensity, not necessarily every real issue: a 0 here means no verified open hazard on record, not that none could exist.";
// LAYOUT-V3 WAVE 1d item 15 (2026-08-03): mirrors bearings/cellprofile.py's
// NOISE_PERCENTILE_CAVEAT exactly, grepped live from source. `percentile`
// values on each fixture below are REAL, computed via the exact same
// citywide.percentile_rank() the backend uses, against the live ~7,017-cell
// noise distribution (verified 2026-08-03) -- not fabricated placeholders.
const NOISE_CAVEAT =
  "Ranks this block's 311 noise complaints against every block citywide, though complaint volume reflects who calls 311 as much as real noise and rises faster in gentrifying neighborhoods.";

const EMPTY_COUNTS = { grocery: 0, cafe: 0, bar: 0, restaurant: 0, pharmacy: 0, gym: 0, park: 0, laundry: 0 };

// H3 892a106084bffff, near Huguenot, Staten Island -- the nearest real
// station (S16 Huguenot) is Staten Island Railway, which has no rail path
// to the rest of the subway/PATH network.
const SIR_CELL: CellProfile = {
  h3: "892a106084bffff",
  shard: "862a1060fffffff",
  centroid: { lat: 40.53565447283312, lng: -74.18829945736736 },
  noise: { complaints_12mo: 1, percentile: 15.932734786945987, caveat: NOISE_CAVEAT, source: NOISE_SOURCE },
  amenities: { counts: EMPTY_COUNTS, source: AMENITIES_SOURCE },
  trees: { street_trees: 113, source: TREES_SOURCE },
  building_age: { median_year_built: 1985.0, era: "postwar", source: PLUTO_SOURCE },
  transit: {
    stations_within_500m: 1,
    to_anchors: { midtown: -1, wtc: -1, downtown_brooklyn: -1, newport_path: -1 },
    unreachable_reason: {
      midtown: "no_rail_connection",
      wtc: "no_rail_connection",
      downtown_brooklyn: "no_rail_connection",
      newport_path: "no_rail_connection",
    },
    caveat: CAVEAT,
    source: TRANSIT_SOURCE,
  },
  safety: {
    precinct: 123,
    crime: { week_ending: "7/12/2026", robbery_ytd: 14, felony_assault_ytd: 65, total_ytd: 287, crime_percentile: 4.487179487179487 },
    crime_caveat: CRIME_CAVEAT,
    source: CRIME_SOURCE,
  },
  housing_hazards: { class_c_violations: 0, note: HAZARD_NOTE, source: HAZARD_SOURCE },
};

// H3 892a1060e4fffff, a real cell a short walk from the one above -- zero
// subway or PATH stations of any kind fall within the real search radius.
const NO_STATION_CELL: CellProfile = {
  ...SIR_CELL,
  h3: "892a1060e4fffff",
  centroid: { lat: 40.55108963109203, lng: -74.201760142681 },
  noise: { complaints_12mo: 6, percentile: 28.01054581730084, caveat: NOISE_CAVEAT, source: NOISE_SOURCE },
  trees: { street_trees: 133, source: TREES_SOURCE },
  building_age: { median_year_built: 1980.0, era: "postwar", source: PLUTO_SOURCE },
  transit: {
    stations_within_500m: 0,
    to_anchors: { midtown: -1, wtc: -1, downtown_brooklyn: -1, newport_path: -1 },
    unreachable_reason: {
      midtown: "no_station_in_range",
      wtc: "no_station_in_range",
      downtown_brooklyn: "no_station_in_range",
      newport_path: "no_station_in_range",
    },
    caveat: CAVEAT,
    source: TRANSIT_SOURCE,
  },
};

// H3 892a100d293ffff, immediately by Grand Central, Manhattan -- this
// project's own named control cell. Every anchor is a real, reachable ride.
const CONTROL_CELL: CellProfile = {
  h3: "892a100d293ffff",
  shard: "862a100d7ffffff",
  centroid: { lat: 40.75015472731649, lng: -73.97717597041498 },
  noise: { complaints_12mo: 70, percentile: 68.41242696308964, caveat: NOISE_CAVEAT, source: NOISE_SOURCE },
  amenities: {
    counts: { grocery: 3, cafe: 15, bar: 4, restaurant: 8, pharmacy: 4, gym: 7, park: 6, laundry: 0 },
    source: AMENITIES_SOURCE,
  },
  trees: { street_trees: 156, source: TREES_SOURCE },
  building_age: { median_year_built: 1920.0, era: "prewar", source: PLUTO_SOURCE },
  transit: {
    stations_within_500m: 3,
    to_anchors: { midtown: 10, wtc: 23, downtown_brooklyn: 23, newport_path: 27 },
    unreachable_reason: { midtown: null, wtc: null, downtown_brooklyn: null, newport_path: null },
    caveat: CAVEAT,
    source: TRANSIT_SOURCE,
  },
  safety: {
    precinct: 17,
    crime: { week_ending: "7/12/2026", robbery_ytd: 21, felony_assault_ytd: 53, total_ytd: 398, crime_percentile: 9.615384615384615 },
    crime_caveat: CRIME_CAVEAT,
    source: CRIME_SOURCE,
  },
  housing_hazards: { class_c_violations: 49, note: HAZARD_NOTE, source: HAZARD_SOURCE },
};

// LAYOUT-V3 WAVE 1 (2026-08-02): CellReportView.tsx split "Getting around"
// (transit) into its own GettingAroundField component -- see that file's
// own top comment. These three tests were always testing transit-specific
// copy only, so they now render GettingAroundField directly; the fixtures
// and assertions themselves are unchanged.
describe("GettingAroundField -- transit unreachable-reason copy", () => {
  it("shows real ride minutes and no explanation paragraph when every anchor is reachable", () => {
    render(<GettingAroundField cell={CONTROL_CELL} />);
    expect(screen.getByText("10 min")).toBeInTheDocument();
    // wtc and downtown_brooklyn are both real 23-minute rides here --
    // two distinct rows legitimately share a value, so this asserts the
    // count rather than using getByText (which throws on >1 match).
    expect(screen.queryAllByText("23 min")).toHaveLength(2);
    expect(screen.getByText("27 min")).toBeInTheDocument();
    expect(screen.queryByText(/no rail link/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no station nearby/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Staten Island Railway/)).not.toBeInTheDocument();
  });

  it("names Staten Island Railway and the ferry gap, not a generic 'no route found', for a real SIR-only cell", () => {
    render(<GettingAroundField cell={SIR_CELL} />);
    // Four anchors, four short "no rail link" value slots.
    expect(screen.getAllByText("no rail link")).toHaveLength(4);
    expect(screen.queryByText(/no route found/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Staten Island Railway.*no rail connection to the rest/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Staten Island Ferry/)).toBeInTheDocument();
    // Must not read as "this place is unreachable" -- the honest framing is
    // a gap in what this report can calculate, not a verdict on the area.
    expect(screen.getByText(/not a sign the area itself is unreachable/)).toBeInTheDocument();
  });

  it("states the real search radius and the subway/PATH-only feed gap for a real no-station cell", () => {
    render(<GettingAroundField cell={NO_STATION_CELL} />);
    expect(screen.getAllByText("no station nearby")).toHaveLength(4);
    expect(screen.queryByText(/no route found/)).not.toBeInTheDocument();
    expect(screen.getByText(/about a 15-minute walk/)).toBeInTheDocument();
    // Must not imply the neighborhood has no transit at all -- only that
    // this report's subway+PATH-only feed found nothing within range.
    expect(screen.getByText(/doesn't check bus routes/)).toBeInTheDocument();
  });
});

// LAYOUT-V3 WAVE 1 (2026-08-02): confirms CellReportView still renders its
// five non-transit fields (now rendered beside the map, not below it) after
// the split above -- a regression guard for the "content-identical" wave-1
// constraint (SPEC-layout-v3.md §8 Wave 1 acceptance).
describe("CellReportView -- five non-transit fields", () => {
  it("renders grocery, crime, noise, trees, and building/hazards for the control cell", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    expect(screen.getByRole("heading", { name: /grocery & everyday places/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /crime near here/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /noise complaints/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /living street trees/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /building age & serious hazards/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /getting around/i })).not.toBeInTheDocument();
  });
});

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 5): the
// per-tile <details> that used to distort `.tilegrid`'s row height is gone
// -- every tile now renders a compact toggle button, and exactly ONE shared
// `.tiledetail` region below the grid shows whichever tile is expanded.
describe("CellReportView -- shared detail region (item 5, no per-tile distortion)", () => {
  it("shows nothing expanded by default, and no shared detail region in the DOM", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("expanding one tile's toggle reveals ONLY that tile's content in the one shared region", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    // Document order: amenities, crime, noise, trees, building.
    fireEvent.click(screen.getAllByRole("button", { name: /\+ details/i })[0]);
    const region = screen.getByRole("region");
    // Real amenity category counts moved verbatim into the shared region.
    expect(within(region).getByText("Grocery")).toBeInTheDocument();
    expect(within(region).getByText("3")).toBeInTheDocument(); // CONTROL_CELL grocery count
    // A different tile's own disclosure content must NOT also be showing.
    expect(within(region).queryByText(/Ranks .* for reported major crime/i)).not.toBeInTheDocument();
  });

  it("expanding a second tile replaces the shared region's content rather than stacking both", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    const toggles = screen.getAllByRole("button", { name: /\+ details/i });
    fireEvent.click(toggles[0]); // amenities
    fireEvent.click(screen.getAllByRole("button", { name: /details/i })[1]); // crime
    const region = screen.getByRole("region");
    expect(within(region).getByText(/Ranks .* for reported major crime/i)).toBeInTheDocument();
    expect(within(region).queryByText("Grocery")).not.toBeInTheDocument();
    // Exactly one shared region ever exists, never two stacked ones.
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("clicking an already-expanded tile's toggle collapses the shared region", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    const toggle = screen.getAllByRole("button", { name: /\+ details/i })[0];
    fireEvent.click(toggle);
    expect(screen.getByRole("region")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /− details/i }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});

// LAYOUT-V3 WAVE 1c (2026-08-03, SPEC-layout-v3.md §8 Wave 1c item 4): the
// map-highlight callback is driven by real hover/expand state, not fired
// unconditionally -- these tests only exercise the pure React state logic
// (no live map involved, matching this file's own established convention
// of not re-testing MapLibre itself here).
describe("CellReportView -- onTileHighlight wiring (item 4)", () => {
  it("calls onTileHighlight with the tile key on hover, and null on mouse-leave", () => {
    const onTileHighlight = vi.fn();
    render(<CellReportView cell={CONTROL_CELL} onTileHighlight={onTileHighlight} />);
    const amenitiesTile = screen.getByRole("heading", { name: /grocery & everyday places/i }).closest("article")!;
    fireEvent.mouseEnter(amenitiesTile);
    expect(onTileHighlight).toHaveBeenLastCalledWith("amenities");
    fireEvent.mouseLeave(amenitiesTile);
    expect(onTileHighlight).toHaveBeenLastCalledWith(null);
  });

  // LAYOUT-V3 WAVE 1d item 13 (2026-08-03, "why are the hexagons back" --
  // see CellReportView.tsx's own item-13 comment for the live-diagnosed
  // root cause): expanding a tile's disclosure with a real click (no
  // hover) no longer ALSO drives the map highlight -- that fallback was
  // exactly the mechanism that left a real H3 hexagon parked on the map
  // indefinitely once the cursor moved away. This replaces the old
  // "touch-equivalent path" test (which asserted the opposite) with its
  // Wave-1d successor: expanding alone must NOT emphasize the map.
  it("expanding a tile's disclosure (a click, no hover) does NOT drive the map highlight (item 13 fix)", () => {
    const onTileHighlight = vi.fn();
    render(<CellReportView cell={CONTROL_CELL} onTileHighlight={onTileHighlight} />);
    const toggle = screen.getAllByRole("button", { name: /\+ details/i })[0];
    fireEvent.click(toggle); // expand, no hover involved
    expect(onTileHighlight).not.toHaveBeenCalledWith("amenities");
    expect(screen.getByRole("region")).toBeInTheDocument(); // the disclosure itself still opens
  });

  it("clears hover state (and tells the map to drop the highlight) when the cell itself changes", () => {
    const onTileHighlight = vi.fn();
    const amenitiesTile = () =>
      screen.getByRole("heading", { name: /grocery & everyday places/i }).closest("article")!;
    const { rerender } = render(<CellReportView cell={CONTROL_CELL} onTileHighlight={onTileHighlight} />);
    fireEvent.mouseEnter(amenitiesTile());
    expect(onTileHighlight).toHaveBeenLastCalledWith("amenities");

    rerender(<CellReportView cell={SIR_CELL} onTileHighlight={onTileHighlight} />);
    expect(onTileHighlight).toHaveBeenLastCalledWith(null);
  });

  it("expanding a disclosure survives a rerender with the SAME cell, and still collapses on toggle (regression guard, item 13)", () => {
    render(<CellReportView cell={CONTROL_CELL} />);
    const toggle = screen.getAllByRole("button", { name: /\+ details/i })[0];
    fireEvent.click(toggle);
    expect(screen.getByRole("region")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /− details/i }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
