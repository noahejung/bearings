import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CellProfile } from "./types";

// The mocked default export's test-only escape hatch -- see the vi.mock()
// factory below for why this can't just be a module-scope variable.
const getLastMap = () =>
  (
    maplibregl as unknown as {
      __getLastMap: () => {
        _handlers: Map<string, (...a: never[]) => void>;
        _paintProps: Map<string, unknown>;
      } | null;
    }
  ).__getLastMap();

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
    // MOTION WAVE (2026-08-03): records every real setPaintProperty() call
    // MapView.tsx makes -- lets tests below assert the actual transition
    // config landed on the actual layer, not just that the call didn't
    // throw (this file's own established bar: `getLastMap()` exists
    // specifically so this fake exercises MapView's real effect logic).
    _paintProps = new Map<string, unknown>();
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
    setPaintProperty(layerId: string, name: string, value: unknown) {
      this._paintProps.set(`${layerId}:${name}`, value);
      return this;
    }
    setFeatureState() {
      return this;
    }
    // LAYOUT-V3 WAVE 1e: MapView.tsx's citywide-cell click handler now also
    // queries the "buildings-residential-hover" layer at the click point to
    // decide whether to show/clear the per-building info marker (see that
    // handler's own comment for why one handler does both lookups). jsdom
    // has no WebGL hit-testing (this file's own top comment), so this fake
    // always reports "no building under the click" -- the tests below don't
    // exercise the building-marker path, only that a real citywide-cell
    // click still swaps the block report correctly with this method present
    // and not throwing.
    queryRenderedFeatures() {
      return [];
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
    // A plausible (not geodesically real) lng/lat -> screen-pixel mapping --
    // MapView.tsx's tiered-label collision placer (2026-08-02) calls the
    // real map.project() to build each label's on-screen box; jsdom has no
    // WebGL projection matrix to call for real, but tests here never assert
    // an exact pixel position, only that real fetched label data reaches
    // real DOM nodes, so a fixed linear scale (spread far enough apart that
    // this file's own fixture entries, e.g. CITYWIDE below, don't spuriously
    // collide with each other) is enough.
    project([lng, lat]: [number, number]) {
      return { x: (lng + 74) * 100_000, y: (41 - lat) * 100_000 };
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

// WAVE 6f item 7 (2026-08-11): GET /api/geocode/reverse's own real response
// shape (bearings/api.py's get_geocode_reverse()) -- distinct from
// GEOCODE_RESULT above (no bbl/cell, a real `approximate: true` flag) so a
// stub can tell "the user searched this" apart from "a bare click resolved
// near this," the same distinction App.tsx's own searchedAddress vs.
// approxAddress state draws.
const REVERSE_GEOCODE_RESULT = {
  label: "3235 HENRY HUDSON PARKWAY, Bronx, NY, USA",
  lat: 40.895,
  lng: -73.905,
  approximate: true as const,
};

const ESB_CELL_PROFILE = {
  h3: ESB_CELL,
  shard: "862a100d7ffffff",
  centroid: { lat: 40.74992386935106, lng: -73.98572782944613 },
  noise: {
    complaints_12mo: 140,
    // LAYOUT-V3 WAVE 1d item 15 (2026-08-03): a real percentile, computed
    // via citywide.percentile_rank() against the live ~7,017-cell noise
    // distribution for this exact complaint count (verified 2026-08-03) --
    // not a fabricated placeholder.
    percentile: 80.17671369531139,
    caveat:
      "Ranks this block's 311 noise complaints against every block citywide, though complaint volume reflects who calls 311 as much as real noise and rises faster in gentrifying neighborhoods.",
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
    percentile: 28.01054581730084,
    caveat:
      "Ranks this block's 311 noise complaints against every block citywide, though complaint volume reflects who calls 311 as much as real noise and rises faster in gentrifying neighborhoods.",
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
  // LAYOUT-V3 WAVE 1e: every real footprint now carries its own real PLUTO/
  // HPD attributes (types.ts's MapBuilding) -- this fixture's one footprint
  // is deliberately a real, non-null residential building (not all-null),
  // matching this project's own "a fixture that only ever observes zeros/
  // Nones proves nothing" rule for the App.test.tsx-level integration
  // surface (MapView.test.ts-equivalent coverage for the actual attribute
  // join lives in test_buildings.py/test_mapgeo.py on the backend).
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
      year_built: 1931,
      era: "prewar",
      residential: false,
      hazard_class_c: 0,
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

// Wave 6c item 7's own regression test needs a subway_lines entry that
// actually carries a real `shape_id` (Wave 4's own join key for the
// route-line preview, MapLine.shape_id in types.ts) -- MAP_GEOMETRY above
// predates that field and every other existing test only needs the line to
// render, never to be matched by shape_id, so it's left alone rather than
// widening a fixture every other test also shares.
const MAP_GEOMETRY_WITH_SHAPE_ID = {
  ...MAP_GEOMETRY,
  subway_lines: [{ ...MAP_GEOMETRY.subway_lines[0], shape_id: "B..N65R" }],
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

// The real GET /api/reach CONTRACT SHAPE (bearings/reach.py's reach()),
// with real place/station names for the same Empire State Building address
// tests/test_reach.py verifies live -- the exact `radius_m` values are the
// real WALK_SPEED_MPS*minutes*60 numbers, but `polygon` here is a
// simplified 3-point placeholder (this file only needs to prove the fetch
// wiring and rendering work, not re-assert reach.py's own live-geometry
// tests, which already do that against the real backend).
const REACH = {
  center: { lat: 40.748441, lng: -73.985656 },
  bands: [
    { minutes: 5, radius_m: 405.0, polygon: [[40.7488, -73.9857], [40.7481, -73.9857], [40.7488, -73.9857]] },
    { minutes: 10, radius_m: 810.0, polygon: [[40.7492, -73.9857], [40.7477, -73.9857], [40.7492, -73.9857]] },
    { minutes: 15, radius_m: 1215.0, polygon: [[40.7496, -73.9857], [40.7473, -73.9857], [40.7496, -73.9857]] },
  ],
  places: [
    { name: "Blue Bottle Coffee", category: "cafe", lat: 40.749, lng: -73.986, band_minutes: 5 },
    { name: "Keens Steakhouse", category: "bar", lat: 40.7505, lng: -73.9877, band_minutes: 10 },
  ],
  stations: [
    { name: "34 St-Herald Sq", lat: 40.7497, lng: -73.9877, routes: ["B", "D", "F", "M"], band_minutes: 5 },
  ],
  method_note:
    "Roughly how far you could walk in 5, 10, and 15 minutes at a normal walking pace, measured as a straight line.",
  sources: {
    places: { name: "Overture Maps Places", url: "https://docs.overturemaps.org/guides/places/" },
    stations: {
      name: "MTA GTFS + PATH GTFS",
      url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
    },
  },
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      // Checked BEFORE the plain "/api/geocode" branch below -- that
      // substring also matches "/api/geocode/reverse", and the two are
      // real, differently-shaped endpoints (see REVERSE_GEOCODE_RESULT's
      // own comment).
      if (url.includes("/api/geocode/reverse")) {
        return Promise.resolve(new Response(JSON.stringify(REVERSE_GEOCODE_RESULT), { status: 200 }));
      }
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
      if (url.includes("/api/reach")) {
        return Promise.resolve(new Response(JSON.stringify(REACH), { status: 200 }));
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

  // WAVE 6f item 8 (2026-08-11): saved places now persist across mounts via
  // localStorage (App.tsx's own effect) -- cleared before every test so one
  // test's save can't leak into the next test's fresh `render(<App />)`.
  window.localStorage.clear();

  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App (full mount)", () => {
  it("opens straight at the search bar, mounts the citywide map immediately, and submits an address via the fast geocode+cell path", async () => {
    render(<App />);

    // LAYOUT-V3 WAVE 1d items 6/7 (2026-08-03): the masthead ("Bearings" +
    // tagline) and the top address-labeling band are both gone -- the app
    // opens directly at the search bar, no title ceremony above it.
    expect(screen.queryByText("Bearings")).not.toBeInTheDocument();
    // WAVE 6f item 7 (2026-08-11): the resting placeholder is a plain
    // instruction now, not an address-shaped example (see AddressSearch.tsx's
    // own item 7 comment for why -- a fixed real-looking placeholder read as
    // a stuck value).
    expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveAttribute("placeholder", "SEARCH AN NYC ADDRESS…");

    // The map is visible before any search or click -- Task 1/4: it must
    // not be gated behind a loaded report. LAYOUT-V3 WAVE 1c (2026-08-03,
    // SPEC-layout-v3.md §8 Wave 1c item 2) removed the decorative "The
    // neighbourhood, navigable" kicker that used to sit above the map --
    // this aria-label on the canvas itself already carries the equivalent
    // fact for anyone who can't see the map render, so proof-of-mount now
    // rests on it alone.
    expect(screen.getByLabelText(/Navigable map of New York City/i)).toBeInTheDocument();

    const input = screen.getByRole("combobox", { name: /nyc address/i });
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    // The real geocoded label canonicalizes into the search field's own
    // value -- resolved via GET /api/geocode, not the old live
    // GET /api/profile. WAVE 6h item 2 removed the separate identity
    // heading this used to also check for (it duplicated the exact same
    // fact); the field is the one place this now lives.
    await waitFor(() => expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveValue(GEOCODE_RESULT.label));

    // The real block-level report fields, from CellReportView -- named
    // by their own heading (VISUAL.md §1's NO-LARP rule). LAYOUT-V3 WAVE 1e
    // (2026-08-03): "building age & serious hazards" is REMOVED from this
    // grid -- it becomes a real per-building map interaction instead (see
    // CellReportView.tsx's own item-1e comment), so its absence here is
    // asserted explicitly, not just left out.
    //
    // LAYOUT-V3 WAVE 1f item 5 (2026-08-11): "Getting around" is no longer
    // a visible heading -- its accessible name now lives on the `<article>`
    // itself (`aria-label`, GettingAroundField's own comment), so this
    // asserts the accessible NAME survives via `getByRole("article", ...)`
    // (an `<article>`'s own implicit ARIA role) instead of
    // `getByRole("heading", ...)`. Wave 1f item 4 also moved this card into
    // the side panel -- "Midtown"'s real ride-time bar (asserted below) is
    // the actual regression guard that it still renders at all.
    expect(screen.getByRole("article", { name: /getting around/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /grocery & everyday places/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /crime near here/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /noise complaints/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /living street trees/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /building age & serious hazards/i })).not.toBeInTheDocument();

    // Real values actually reached the DOM, not just the field chrome.
    expect(screen.getByText("140")).toBeInTheDocument(); // noise complaints
    expect(screen.getByText("4 min")).toBeInTheDocument(); // ride time to Midtown

    // The fact-check section is present, wired to the real searched address.
    expect(screen.getByRole("heading", { name: /check a listing/i })).toBeInTheDocument();

    // NO-LARP regression (VISUAL.md §1): the fictional bureau, catalogue
    // codes, and refusals line must never come back.
    expect(screen.queryByText(/Peoples Bureau/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/BRG—/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NO LISTINGS/i)).not.toBeInTheDocument();
  });

  // MOTION WAVE (2026-08-03, SPEC "data-viz animations wave" item 3): proves
  // the map's real paint-property transitions actually land on the actual
  // layers, and that the destination-preview trio's transition DURATION
  // really does flip per direction (entering vs. exiting) -- the load-
  // bearing, easiest-to-get-wrong half of this wave's map work, per
  // MapView.tsx's own effect 10c comment. Not just "doesn't throw."
  it("sets real GPU-side paint-property transitions on mount, and flips the destination-preview duration on hover enter/exit", async () => {
    render(<App />);
    await waitFor(() => expect(getLastMap()).not.toBeNull());
    const map = getLastMap()!;

    // Static, persisting-feature hover transitions -- set once, at layer-add
    // time, and never change again.
    expect(map._paintProps.get("citywide-cells-fill:fill-opacity-transition")).toEqual({ duration: 160 });
    expect(map._paintProps.get("buildings-residential-hover:fill-opacity-transition")).toEqual({ duration: 160 });
    expect(map._paintProps.get("tile-highlight-fill:fill-opacity-transition")).toEqual({ duration: 200 });
    expect(map._paintProps.get("tile-highlight-outline:fill-opacity-transition")).toBeUndefined(); // wrong prop name -- outline is a line layer
    expect(map._paintProps.get("tile-highlight-outline:line-opacity-transition")).toEqual({ duration: 200 });
    expect(map._paintProps.get("tile-highlight-points:circle-opacity-transition")).toEqual({ duration: 200 });

    // Destination-preview defaults to the ENTER duration before any hover
    // has ever happened (MapView.tsx effect 2's own comment: "the sane
    // starting default").
    expect(map._paintProps.get("destination-rings-fill:fill-opacity-transition")).toEqual({ duration: 200 });

    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(screen.getByText("Midtown")).toBeInTheDocument());

    const row = screen.getByText("Midtown").closest('[role="button"]') as HTMLElement;
    fireEvent.mouseEnter(row);
    await waitFor(() =>
      expect(map._paintProps.get("destination-rings-fill:fill-opacity-transition")).toEqual({ duration: 200 }),
    );
    expect(map._paintProps.get("destination-point:circle-radius-transition")).toEqual({ duration: 200 });

    fireEvent.mouseLeave(row);
    await waitFor(() =>
      expect(map._paintProps.get("destination-rings-fill:fill-opacity-transition")).toEqual({ duration: 130 }),
    );
    expect(map._paintProps.get("destination-rings-outline:line-opacity-transition")).toEqual({ duration: 130 });
    expect(map._paintProps.get("destination-point:circle-opacity-transition")).toEqual({ duration: 130 });
  });

  it("renders a real 'no data' state for a block with no precinct match, never a fabricated number", async () => {
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), {
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
        if (url.includes("/api/reach")) {
          return Promise.resolve(new Response(JSON.stringify(REACH), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveValue("3220 NETHERLAND AVENUE"));

    expect(screen.getByText(/We don.t have crime data for this block yet/i)).toBeInTheDocument();
  });

  it("clicking a grid cell swaps the report to that cell's data (the missing click-to-load feature)", async () => {
    render(<App />);

    // Search an address first, so there's a real, different report on
    // screen to prove the click actually SWAPS it.
    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveValue(GEOCODE_RESULT.label));
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

    // A bare click carries no SEARCHED address -- the previously searched
    // address must be cleared, not left in the field implying this
    // block-level record is still about a specific address it no longer is.
    // LAYOUT-V3 WAVE 1d item 2 (2026-08-03): the old "This block" framing
    // fallback stays gone -- no INVENTED area label (the tiles below are the
    // honest record either way).
    expect(screen.queryByText("This block")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveValue("");
    // WAVE 6f item 7 (2026-08-11, Noah: "a bare click cell shows nothing"):
    // unlike the invented-label fallback above, a REAL reverse-geocoded hint
    // now appears once GET /api/geocode/reverse resolves, as the field's own
    // placeholder -- marked "≈" so it's never mistaken for a confirmed
    // search result. WAVE 6h item 2 removed the separate identity heading
    // this used to also check for (it duplicated the exact same fact).
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveAttribute(
        "placeholder",
        `≈ ${REVERSE_GEOCODE_RESULT.label}`,
      ),
    );
    // The fact-check section requires a real searched address -- it must not
    // render for an addressless block click, even with an approx hint shown.
    expect(screen.queryByRole("heading", { name: /check a listing/i })).not.toBeInTheDocument();
  });

  // WAVE 6f item 8 (2026-08-11, Noah: "instead of pin can we just click
  // save"): the save button, the sidebar list it feeds, and the localStorage
  // persistence bridge (SPEC-data-layer-v2.md §6) all exercised through the
  // real component tree, not unit-tested in isolation.
  it("saving an address adds it to the sidebar list and persists it across a fresh mount", async () => {
    const { unmount } = render(<App />);

    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // The saved label renders twice on a real page (the sidebar list AND
    // the map's own savedmarker badge, MapView.tsx's own effect 11) --
    // getAllByText, not getByText, is the correct query here.
    await waitFor(() => expect(screen.getAllByText(GEOCODE_RESULT.label).length).toBeGreaterThan(0));
    expect(window.localStorage.getItem("bearings.savedPlaces")).toContain(GEOCODE_RESULT.label);

    // A fresh mount (the real shape of a page reload) reads the same saved
    // place straight from localStorage -- no search, no click, nothing else
    // driving it onto the screen this time.
    unmount();
    render(<App />);
    expect(screen.getAllByText(GEOCODE_RESULT.label).length).toBeGreaterThan(0);
  });

  it("unsaving a place removes it from the sidebar list and from localStorage", async () => {
    render(<App />);

    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getAllByText(GEOCODE_RESULT.label).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`unsave ${GEOCODE_RESULT.label}`, "i") }));
    expect(screen.queryAllByText(GEOCODE_RESULT.label)).toHaveLength(0);
    expect(window.localStorage.getItem("bearings.savedPlaces")).not.toContain(GEOCODE_RESULT.label);
  });
});

// WAVE 6c item 7 (2026-08-11, Noah: "route lines don't preview"). REPRODUCED
// live via Playwright before writing this test, then root-caused: the
// toggle -> hover -> GET /api/route -> onRouteHighlight -> MapView's own
// route-line effect wiring is entirely correct (GettingAroundField's own
// existing tests already cover that half). The real gap is that
// routeLineGeoJSON() also needs `geo` (GET /api/map's building/street/subway
// overlay, fetched independently and separately timed) to resolve a
// shape_id into real coordinates -- and GET /api/route can genuinely
// resolve BEFORE GET /api/map does (measured live: GET /api/map took a
// consistent ~4-5s server-side on this exact machine, GET /api/route
// resolves fast, no shared latency). Before this wave, that window drew
// nothing with zero explanation. This test reproduces the exact race (a
// deliberately never-resolving-until-told-to /api/map fetch, standing in
// for that real multi-second gap) and proves the new feature-specific
// loading note (MapView.tsx, next to the amenities-tile note it copies the
// pattern from) appears during the gap and clears once `geo` actually
// lands -- not just that the final state is eventually correct.
describe("Route line preview during the real GET /api/map latency window (Wave 6c item 7)", () => {
  it("shows a route-specific loading note while /api/map is still in flight, then clears it once the real line can draw", async () => {
    let resolveMapGeometry: (value: Response) => void = () => {};
    const pendingMapGeometry = new Promise<Response>((resolve) => {
      resolveMapGeometry = resolve;
    });

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
          return body
            ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
            : Promise.resolve(new Response("not found", { status: 404 }));
        }
        if (url.includes("/api/map")) {
          // Never resolves until this test explicitly calls resolveMapGeometry() --
          // standing in for GET /api/map's real, measured multi-second latency.
          return pendingMapGeometry;
        }
        if (url.includes("/api/citywide")) {
          return Promise.resolve(new Response(JSON.stringify(CITYWIDE), { status: 200 }));
        }
        if (url.includes("/api/reach")) {
          return Promise.resolve(new Response(JSON.stringify(REACH), { status: 200 }));
        }
        if (url.includes("/api/route")) {
          // Resolves immediately -- the real, independent-latency fetch this
          // whole bug hinges on racing ahead of /api/map.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                reachable: true,
                reason: null,
                minutes: 4,
                steps: [],
                shape_ids: ["B..N65R"],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: /nyc address/i }), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /nyc address/i })).toHaveValue(GEOCODE_RESULT.label));

    // Turn route lines on and hover the first anchor row -- /api/map is
    // still pending at this point (deliberately never resolved yet).
    fireEvent.click(screen.getByRole("button", { name: /route lines/i }));
    const row = screen.getByText("Midtown").closest('[role="button"]') as HTMLElement;
    fireEvent.mouseEnter(row);

    // The real route resolves fast (its own fetch branch above), so
    // MapView receives a real, non-empty routeHighlight while `geo` is
    // still null -- exactly the reproduced race. The feature-specific note
    // must appear (not silence, not the generic map-loading text alone).
    await waitFor(() =>
      expect(screen.getByText(/finding the real route line/i)).toBeInTheDocument(),
    );

    // Resolving /api/map now lets the route line actually draw -- the note
    // must clear once that happens, not linger past the real wait.
    act(() => {
      resolveMapGeometry(new Response(JSON.stringify(MAP_GEOMETRY_WITH_SHAPE_ID), { status: 200 }));
    });
    await waitFor(() =>
      expect(screen.queryByText(/finding the real route line/i)).not.toBeInTheDocument(),
    );

    const map = getLastMap() as unknown as {
      _sources: Map<string, { data: { features: unknown[] } }>;
    } | null;
    expect(map?._sources.get("route-line")?.data.features.length).toBe(1);
  });
});
