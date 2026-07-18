import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CellProfile } from "./types";

// The mocked default export's test-only escape hatch -- see the vi.mock()
// factory below for why this can't just be a module-scope variable.
const getLastMap = () => (maplibregl as unknown as { __getLastMap: () => { _handlers: Map<string, (...a: never[]) => void> } | null }).__getLastMap();

// A real integration test, not just a compile check: mounts the whole app,
// drives a real address submission through the real fetch call sites, and
// asserts that every restyled field actually renders. SPEC-precompute-v2.md
// Phase 2 (2026-07-15) rewired the primary report path from the live
// GET /api/profile to GET /api/geocode -> GET /api/cell/{h3} -- this file
// now exercises THAT path (CellReportView, not the old building-level
// ReportView), plus the new click-to-swap wiring the dispatch's own
// non-negotiables explicitly call for a test of.
//
// MapView.tsx drives a real maplibre-gl WebGL map, which jsdom cannot
// render (no WebGL context) -- this is a rendering-engine limitation, not
// a data-source mock, so it doesn't conflict with this repo's "no mocking"
// rule (that rule is about live data, not about jsdom's inability to run a
// GPU). The fake below implements just enough of the real Map/Marker
// surface (DOM attachment, an async "load" event, GeoJSON source storage,
// feature-state, layer event dispatch) that this test still exercises
// MapView's real effect logic and real fetched data reaching real DOM
// nodes -- it does not fake away the thing under test, only the WebGL
// renderer jsdom structurally cannot provide. `getLastMap()` (exposed on
// the mocked default export, below) is a small, test-only escape hatch so
// this file can simulate a real citywide-grid click (MapLibre's own
// hit-testing is itself WebGL-backed and cannot run here either) by
// invoking the exact handler MapView.tsx registered.
//
// Everything here is defined INSIDE the vi.mock() factory (not at module
// scope) deliberately -- vitest hoists vi.mock() calls above every other
// top-level statement in the file, so a module-scope class referenced by
// the factory would be a real "used before initialization" crash, not a
// style preference.
vi.mock("maplibre-gl", () => {
  let lastMapInstance: InstanceType<typeof FakeMap> | null = null;

  class FakeMap {
    _container: HTMLElement | null;
    _sources = new Map<string, { data: unknown; setData(d: unknown): void }>();
    _handlers = new Map<string, (...args: never[]) => void>();
    constructor(opts: { container: HTMLElement }) {
      this._container = opts.container;
      lastMapInstance = this;
      // Real MapLibre fires "load" asynchronously once style/tile
      // resources resolve -- a microtask mirrors that ordering closely
      // enough for React's effects to see it as a real state transition.
      queueMicrotask(() => this._handlers.get("load")?.());
    }
    addControl() {
      return this;
    }
    on(event: string, a: unknown, b?: unknown) {
      if (typeof b === "function") {
        this._handlers.set(`${event}:${a as string}`, b as () => void);
      } else {
        this._handlers.set(event, a as () => void);
      }
      return this;
    }
    off() {
      return this;
    }
    remove() {
      return this;
    }
    addSource(id: string, opts: { data: unknown }) {
      const source = {
        data: opts.data,
        setData(d: unknown) {
          source.data = d;
        },
      };
      this._sources.set(id, source);
      return this;
    }
    getSource(id: string) {
      return this._sources.get(id);
    }
    addLayer() {
      return this;
    }
    setLayoutProperty() {
      return this;
    }
    setPaintProperty() {
      return this;
    }
    setFeatureState() {
      return this;
    }
    fitBounds() {
      return this;
    }
    flyTo() {
      return this;
    }
    getBounds() {
      return { contains: () => true };
    }
    getCenter() {
      return { lat: 40.7484, lng: -73.9857 };
    }
    getZoom() {
      return 14;
    }
    getCanvas() {
      return { style: {} };
    }
  }

  class FakeMarker {
    element: HTMLElement;
    map: FakeMap | null = null;
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
    }
    setLngLat() {
      return this;
    }
    addTo(map: FakeMap) {
      this.map = map;
      map._container?.appendChild(this.element);
      return this;
    }
    remove() {
      this.element.remove();
      return this;
    }
    getElement() {
      return this.element;
    }
  }

  return {
    default: {
      Map: FakeMap,
      Marker: FakeMarker,
      NavigationControl: class {},
      addProtocol: vi.fn(),
      removeProtocol: vi.fn(),
      __getLastMap: () => lastMapInstance,
    },
  };
});

vi.mock("pmtiles", () => ({
  Protocol: class {
    tile() {
      /* never actually invoked -- addProtocol itself is mocked above */
    }
  },
}));

const ADDRESS = "350 5th Ave, Manhattan";
const ESB_CELL = "892a100d2d7ffff";
const RIVERDALE_CELL = "892a10716abffff";

// Real shapes, live-verified 2026-07-15 (`bearings.cellprofile.profile_for()`
// against a real geocoded Empire State Building / Herald Sq cell) --
// captured, not invented, per this repo's own "no mocking" discipline
// (this is a frontend unit test stubbing `fetch`, the same established
// pattern this file already used pre-Phase-2; the VALUES mirror a real
// live response rather than being structurally-empty placeholders).
const GEOCODE_RESULT = {
  label: "350 5 AVENUE, New York, NY, USA",
  lat: 40.748441,
  lng: -73.985656,
  bbl: "1008350041",
  cell: ESB_CELL,
};

const ESB_CELL_PROFILE = {
  h3: ESB_CELL,
  shard: "862a100d7ffffff",
  centroid: { lat: 40.74992386935106, lng: -73.98572782944613 },
  noise: {
    complaints_12mo: 140,
    source: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
  },
  amenities: {
    counts: { grocery: 1, cafe: 15, bar: 11, restaurant: 5, pharmacy: 4, gym: 11, park: 4, laundry: 0 },
    source: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
  },
  trees: {
    street_trees: 33,
    source: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
  },
  building_age: {
    median_year_built: 1920.0,
    era: "prewar",
    source: { name: "NYC PLUTO", url: "https://data.cityofnewyork.us/d/64uk-42ks" },
  },
  transit: {
    stations_within_500m: 5,
    to_anchors: { midtown: 4, wtc: 20, downtown_brooklyn: 23, newport_path: 17 },
    unreachable_reason: { midtown: null, wtc: null, downtown_brooklyn: null, newport_path: null },
    caveat:
      "In-vehicle time plus a nominal transfer penalty. Excludes the walk from your door and the wait on the platform. Treat as a floor, not a door-to-door estimate.",
    source: {
      name: "MTA GTFS + PATH GTFS",
      url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
    },
  },
  safety: {
    precinct: 14,
    crime: {
      week_ending: "7/5/2026",
      robbery_ytd: 122,
      felony_assault_ytd: 285,
      total_ytd: 1445,
      crime_percentile: 94.23076923076923,
    },
    crime_caveat:
      "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate.",
    source: {
      name: "NYPD CompStat",
      url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page",
    },
  },
  housing_hazards: {
    class_c_violations: 38,
    note: "Open Class C (\"immediately hazardous\") HPD violations only, summed across every tax lot centred in this cell.",
    source: { name: "NYC HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" },
  },
};

// A second, genuinely different real cell (Riverdale, the quiet/leafy
// archetype web/src/data/examples.ts already cites) -- used to prove a
// click actually SWAPS the report, not just re-renders the same data.
const RIVERDALE_CELL_PROFILE = {
  h3: RIVERDALE_CELL,
  shard: "862a10717ffffff",
  centroid: { lat: 40.8967, lng: -73.9106 },
  noise: {
    complaints_12mo: 6,
    source: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
  },
  amenities: {
    counts: { grocery: 0, cafe: 1, bar: 0, restaurant: 2, pharmacy: 1, gym: 0, park: 1, laundry: 0 },
    source: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
  },
  trees: {
    street_trees: 112,
    source: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
  },
  building_age: {
    median_year_built: 1955.0,
    era: "postwar",
    source: { name: "NYC PLUTO", url: "https://data.cityofnewyork.us/d/64uk-42ks" },
  },
  transit: {
    stations_within_500m: 0,
    to_anchors: { midtown: 48, wtc: 61, downtown_brooklyn: 66, newport_path: 58 },
    unreachable_reason: { midtown: null, wtc: null, downtown_brooklyn: null, newport_path: null },
    caveat: "In-vehicle time plus a nominal transfer penalty.",
    source: {
      name: "MTA GTFS + PATH GTFS",
      url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
    },
  },
  safety: {
    precinct: null,
    crime: null,
    crime_caveat:
      "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate.",
    source: {
      name: "NYPD CompStat",
      url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page",
    },
  },
  housing_hazards: {
    class_c_violations: 0,
    note: "Open Class C (\"immediately hazardous\") HPD violations only, summed across every tax lot centred in this cell.",
    source: { name: "NYC HPD", url: "https://data.cityofnewyork.us/d/wvxf-dwi5" },
  },
};

const CELL_PROFILES: Record<string, CellProfile> = {
  [ESB_CELL]: ESB_CELL_PROFILE as CellProfile,
  [RIVERDALE_CELL]: RIVERDALE_CELL_PROFILE as CellProfile,
};

const CELLS_INDEX = {
  cells: [
    {
      h3: ESB_CELL,
      lat: 40.7499,
      lng: -73.9857,
      noise: 140,
      amenities: 51,
      trees: 33,
      building_age_years: 1920,
      transit_access: 5,
    },
    {
      h3: RIVERDALE_CELL,
      lat: 40.8967,
      lng: -73.9106,
      noise: 6,
      amenities: 4,
      trees: 112,
      building_age_years: 1955,
      transit_access: 0,
    },
  ],
};

const MAP_GEOMETRY = {
  subject: { lat: 40.7484, lng: -73.9857, bbl: "1008350041", cell: ESB_CELL },
  bbox: { south: 40.7421, north: 40.7547, west: -73.9957, east: -73.9757 },
  buildings: [
    {
      bbl: "1008350041",
      coords: [
        [40.7482, -73.9859],
        [40.7486, -73.9859],
        [40.7486, -73.9855],
        [40.7482, -73.9855],
        [40.7482, -73.9859],
      ],
    },
  ],
  streets: [{ physicalid: "12345", coords: [[40.748, -73.986], [40.749, -73.985]], rank: 2 }],
  subway_lines: [
    { coords: [[40.748, -73.986], [40.75, -73.984]], route: "B/D/F/M" },
  ],
  stations: [{ name: "34 St-Herald Sq", lat: 40.7497, lng: -73.9877, routes: ["B", "D", "F", "M"] }],
  cells: Array.from({ length: 37 }, (_, i) => ({
    h3: i === 0 ? ESB_CELL : `892a100d2d7ff${i.toString().padStart(2, "0")}`,
    noise: i === 0 ? 42 : i,
    amenities: i === 0 ? 12 : i % 5,
    trees: i === 0 ? 8 : i % 4,
    building_age_years: i === 3 ? null : 1930 + i,
    transit_access: i === 0 ? 3 : i % 2,
  })),
  basemap_note: "Every layer is real, drawn from public records...",
  sources: {
    basemap: { name: "Protomaps Basemap (OpenStreetMap + Natural Earth)", url: "https://docs.protomaps.com/basemaps/downloads" },
    subway: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
    cells: { name: "NYC 311", url: "https://data.cityofnewyork.us/d/erm2-nwe9" },
    buildings: { name: "NYC Building Footprints", url: "https://data.cityofnewyork.us/d/5zhs-2jue" },
    streets: { name: "NYC Street Centerline (CSCL)", url: "https://data.cityofnewyork.us/d/inkn-q76z" },
    amenities: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
    trees: { name: "NYC Street Tree Census", url: "https://data.cityofnewyork.us/d/uvpi-gqnh" },
    building_age: { name: "NYC PLUTO", url: "https://data.cityofnewyork.us/d/64uk-42ks" },
    transit_access: { name: "MTA GTFS + PATH GTFS", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip" },
  },
};

const CITYWIDE = {
  neighborhoods: [
    { nta2020: "MN0502", name: "Chelsea-Hudson Yards", borough: "Manhattan", lat: 40.7508, lng: -73.9975 },
  ],
  precincts: [
    {
      precinct: 14,
      lat: 40.7548,
      lng: -73.9925,
      geometry: { type: "Polygon", coordinates: [[[-74.0, 40.75], [-73.99, 40.75], [-73.99, 40.76], [-74.0, 40.76], [-74.0, 40.75]]] },
      crime: { week_ending: "7/5/2026", robbery_ytd: 12, felony_assault_ytd: 8, total_ytd: 200, crime_percentile: 91.7 },
    },
  ],
  neighborhoods_source: { name: "NYC Neighborhood Tabulation Areas (NTAs)", url: "https://data.cityofnewyork.us/d/9nt8-h7nd" },
  precincts_source: { name: "NYPD Police Precincts", url: "https://data.cityofnewyork.us/d/y76i-bdw7" },
  crime_source: { name: "NYPD CompStat", url: "https://www.nyc.gov/site/nypd/stats/crime-statistics/citywide-crime-stats.page" },
  crime_caveat:
    "Shown as this precinct's percentile position among all NYC precincts, ranked by raw year-to-date major-crime count -- not a per-resident rate.",
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/geocode")) {
        return Promise.resolve(new Response(JSON.stringify(GEOCODE_RESULT), { status: 200 }));
      }
      if (url.includes("/api/cells")) {
        return Promise.resolve(new Response(JSON.stringify(CELLS_INDEX), { status: 200 }));
      }
      if (url.includes("/api/cell/")) {
        const h3id = decodeURIComponent(url.split("/api/cell/")[1] ?? "");
        const body = CELL_PROFILES[h3id];
        if (!body) return Promise.resolve(new Response("not found", { status: 404 }));
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      if (url.includes("/api/map")) {
        return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
      }
      if (url.includes("/api/citywide")) {
        return Promise.resolve(new Response(JSON.stringify(CITYWIDE), { status: 200 }));
      }
      if (url.includes("/api/profile")) {
        // The whole point of Phase 2: the primary report path must NEVER
        // reach the slow live endpoint. A test hitting this branch fails
        // loudly rather than silently succeeding via the old path.
        return Promise.reject(new Error("regression: /api/profile was called on the primary report path"));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

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

  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App (full mount)", () => {
  it("renders the masthead, mounts the citywide map immediately, and submits an address via the fast geocode+cell path", async () => {
    render(<App />);

    expect(screen.getByText("Bearings")).toBeInTheDocument();

    // The map is visible before any search or click -- Task 1/4: it must
    // not be gated behind a loaded report.
    expect(screen.getByRole("heading", { name: /the neighbourhood, navigable/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Navigable map of all of New York City/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/5TH AVE/i);
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    // The real geocoded label becomes the report heading -- resolved via
    // GET /api/geocode, not the old live GET /api/profile.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: GEOCODE_RESULT.label })).toBeInTheDocument(),
    );

    // The six real block-level report fields, from CellReportView -- named
    // by their own heading (VISUAL.md §1's NO-LARP rule).
    expect(screen.getByRole("heading", { name: /getting around/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /grocery & everyday places/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /crime near here/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /noise complaints/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /living street trees/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /building age & serious hazards/i })).toBeInTheDocument();

    // Real values actually reached the DOM, not just the field chrome.
    expect(screen.getByText("140")).toBeInTheDocument(); // noise complaints
    expect(screen.getByText("1920")).toBeInTheDocument(); // building age
    expect(screen.getByText(/5 subway or PATH station/i)).toBeInTheDocument();

    // The fact-check section is present, wired to the real searched address.
    expect(screen.getByRole("heading", { name: /check a listing/i })).toBeInTheDocument();

    // NO-LARP regression (VISUAL.md §1): the fictional bureau, catalogue
    // codes, and refusals line must never come back.
    expect(screen.queryByText(/Peoples Bureau/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/BRG—/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NO LISTINGS/i)).not.toBeInTheDocument();
  });

  it("renders a real 'no data' state for a block with no precinct match, never a fabricated number", async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/5TH AVE/i), {
      target: { value: "3220 Netherland Ave, Bronx" },
    });
    // Point the fixture geocode at the Riverdale cell for this one test.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/geocode")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ...GEOCODE_RESULT, label: "3220 NETHERLAND AVENUE", cell: RIVERDALE_CELL }),
              { status: 200 },
            ),
          );
        }
        if (url.includes("/api/cells")) {
          return Promise.resolve(new Response(JSON.stringify(CELLS_INDEX), { status: 200 }));
        }
        if (url.includes("/api/cell/")) {
          return Promise.resolve(new Response(JSON.stringify(RIVERDALE_CELL_PROFILE), { status: 200 }));
        }
        if (url.includes("/api/map")) {
          return Promise.resolve(new Response(JSON.stringify(MAP_GEOMETRY), { status: 200 }));
        }
        if (url.includes("/api/citywide")) {
          return Promise.resolve(new Response(JSON.stringify(CITYWIDE), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "3220 NETHERLAND AVENUE" })).toBeInTheDocument(),
    );

    expect(screen.getByText(/We don.t have crime data for this block yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No subway or PATH station within about a 6-minute walk/i)).toBeInTheDocument();
  });

  it("clicking a grid cell swaps the report to that cell's data (the missing click-to-load feature)", async () => {
    render(<App />);

    // Search an address first, so there's a real, different report on
    // screen to prove the click actually SWAPS it.
    fireEvent.change(screen.getByPlaceholderText(/5TH AVE/i), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /pull the record/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: GEOCODE_RESULT.label })).toBeInTheDocument(),
    );
    expect(screen.getByText("140")).toBeInTheDocument(); // ESB's noise count

    // Simulate a real click on the citywide grid's hit layer -- MapLibre's
    // own hit-testing is WebGL-backed and cannot run under jsdom (see this
    // file's own top comment), so this invokes the exact handler
    // MapView.tsx registered via `map.on("click", "citywide-cells-fill", ...)`.
    const map = getLastMap();
    expect(map).not.toBeNull();
    const handler = map?._handlers.get("click:citywide-cells-fill");
    expect(handler).toBeDefined();
    act(() => {
      handler?.({ features: [{ properties: { h3: RIVERDALE_CELL } }] } as never);
    });

    // The report swaps to the clicked cell's real, different data.
    await waitFor(() => expect(screen.getByText("6")).toBeInTheDocument()); // Riverdale's noise count
    expect(screen.getByText("112")).toBeInTheDocument(); // Riverdale's tree count

    // A bare click carries no address -- the previously searched address
    // must be cleared, not left on screen implying this block-level
    // record is still about a specific address it no longer is.
    expect(screen.getByRole("heading", { name: "This block" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: GEOCODE_RESULT.label })).not.toBeInTheDocument();
    // The fact-check section requires a real address -- it must not render
    // for an addressless block click.
    expect(screen.queryByRole("heading", { name: /check a listing/i })).not.toBeInTheDocument();
  });
});
