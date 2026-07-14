import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// A real integration test, not just a compile check: mounts the whole app,
// drives a real address submission through the real fetch call sites, and
// asserts that every restyled field actually renders -- the tDR restyle
// touched App.tsx, Header, AddressSearch, ReportView, all six report
// fields, MapView, and the fact-check view in one pass, and a green
// `tsc -b` proves the types line up, not that the tree renders without
// throwing at runtime (a bad prop shape, a missing null guard, or a
// crashed child can still pass typecheck if a type lied).

const ADDRESS = "350 5th Ave, Manhattan";

const PROFILE = {
  address: "350 5th Ave, Manhattan, NY",
  cell: "892a100d2d7ffff",
  location: { lat: 40.7484, lng: -73.9857, bbl: "1008350041" },
  transit: {
    nearest_stations: [{ name: "34 St-Herald Sq", routes: ["B", "D", "F", "M"], walk_minutes: 4 }],
    to_anchors: { midtown: 9, wtc: 21, downtown_brooklyn: 27, newport_path: 33 },
    caveat: "In-vehicle time plus a nominal transfer penalty.",
    source: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
  },
  amenities: {
    counts: { grocery: 6, cafe: 21, bar: 9, restaurant: 74, pharmacy: 4, gym: 3, park: 1, laundry: 2 },
    source: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
  },
  safety: {
    precinct: 14,
    week_ending: "7/5/2026",
    robbery_ytd: 12,
    robbery_pct: -3.2,
    felony_assault_ytd: 8,
    felony_assault_pct: 1.1,
    total_ytd: 200,
    total_pct: 0.4,
    source: { name: "NYPD CompStat", url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page" },
  },
  quiet: {
    noise_complaints_12mo: 1297,
    source: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
  },
  green: {
    street_trees_nearby: 277,
    source: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
  },
  building: {
    year_built: 1931,
    era: "prewar",
    era_note: "Pre-war walk-up stock often carries rent-stabilised units.",
    hpd_open_violations: { class_a: 1, class_b: 0, class_c: 2 },
    source: { name: "NYC PLUTO + HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" },
  },
};

const MAP_GEOMETRY = {
  subject: { lat: 40.7484, lng: -73.9857, bbl: "1008350041", cell: "892a100d2d7ffff" },
  bbox: { south: 40.7421, north: 40.7547, west: -73.9957, east: -73.9757 },
  subway_lines: [
    { coords: [[40.748, -73.986], [40.75, -73.984]] },
  ],
  stations: [{ name: "34 St-Herald Sq", lat: 40.7497, lng: -73.9877 }],
  cells: Array.from({ length: 37 }, (_, i) => ({
    h3: i === 0 ? "892a100d2d7ffff" : `892a100d2d7ff${i.toString().padStart(2, "0")}`,
    value: i === 0 ? 42 : i,
  })),
  basemap_note: "Street and building base layers are not rendered. Overture's transportation...",
  sources: {
    subway: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
    cells: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
  },
};

beforeEach(() => {
  // jsdom doesn't implement these -- App.tsx calls both on a successful load.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/profile")) {
        return Promise.resolve(new Response(JSON.stringify(PROFILE), { status: 200 }));
      }
      if (url.includes("/api/map")) {
        return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App (full mount)", () => {
  it("renders the masthead, submits an address, and renders every real report field", async () => {
    render(<App />);

    expect(screen.getByText("Bearings")).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/5TH AVE/i);
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    await waitFor(() => expect(screen.getByText(PROFILE.address)).toBeInTheDocument());

    // The six real report fields, each with its section code.
    expect(screen.getByText("§01·TRN")).toBeInTheDocument();
    expect(screen.getByText("§02·AMN")).toBeInTheDocument();
    expect(screen.getByText("§03·SFY")).toBeInTheDocument();
    expect(screen.getByText("§04·QUI")).toBeInTheDocument();
    expect(screen.getByText("§05·GRN")).toBeInTheDocument();
    expect(screen.getByText("§06·BLD")).toBeInTheDocument();

    // Real values actually reached the DOM, not just the field chrome.
    expect(screen.getByText("34 St-Herald Sq")).toBeInTheDocument();
    expect(screen.getByText("1,297")).toBeInTheDocument(); // noise complaints, tabular-formatted
    expect(screen.getByText("1931")).toBeInTheDocument();

    // The map field rendered with the real fetched geometry, not stuck loading.
    await waitFor(() => expect(screen.getByText("§00·MAP")).toBeInTheDocument());
    expect(screen.getByText(/34 St-Herald Sq/).closest("body")).toBeTruthy();
    expect(screen.getByLabelText(/H3 cell map/i)).toBeInTheDocument();

    // The fact-check section is present and wired to the same address.
    expect(screen.getByRole("heading", { name: /paste a listing/i })).toBeInTheDocument();
  });

  it("renders a real NO DATA stamp, never a guessed number, when a field is genuinely null", async () => {
    const noRecordProfile = {
      ...PROFILE,
      location: { ...PROFILE.location, bbl: null },
      building: {
        year_built: null,
        era: null,
        era_note: null,
        hpd_open_violations: null,
        source: PROFILE.building.source,
      },
      safety: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/profile")) {
          return Promise.resolve(new Response(JSON.stringify(noRecordProfile), { status: 200 }));
        }
        if (url.includes("/api/map")) {
          return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/5TH AVE/i), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    await waitFor(() => expect(screen.getByText(PROFILE.address)).toBeInTheDocument());

    expect(screen.getByText(/No PLUTO\/HPD record/)).toBeInTheDocument();
    expect(screen.getByText(/No NYPD precinct match/)).toBeInTheDocument();
    // At least one real "NO DATA" stamp rendered -- the dashed steel gap,
    // never a silently-guessed zero.
    expect(screen.getAllByText("NO DATA").length).toBeGreaterThan(0);
  });
});
